/**
 * services/trend-service/server.js
 * [파일 책임]
 * - Trend Service(API) 실제 구현:
 *   1) pytrends로 최근 N일 트렌드 후보 수집
 *   2) Gemini로 (도박/정치 제외 + 우선순위 정렬) 수행
 *   3) keywords 반환
 *
 * Endpoint:
 * - GET /trends/daily?region=KR&days=7
 * Response:
 * - { region, days, keywords, debug }
 */
import dotenv from "dotenv";
import http from "node:http";
import { URL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { GeminiClient } from "./geminiClient.js";
import { channel } from "node:diagnostics_channel";

dotenv.config({ path: path.resolve(process.cwd(), "services/trend-service/.env.trend") });
console.log("[DEBUG] TREND_SERVICE_PORT raw =", JSON.stringify(process.env.TREND_SERVICE_PORT));
const PORT = Number(process.env.TREND_SERVICE_PORT);

const llm = new GeminiClient({
  model: process.env.GEMINI_MODEL || "gemini-3-flash",
  apiKeyPrefix: "GEMINI_API_"
});

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** stderr/메시지에서 429 여부 감지 */
function isRateLimit429(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes(" 429") ||
    t.includes("429 ") ||
    t.includes("too many requests") ||
    t.includes("too many 429") ||
    t.includes("rate limit") ||
    t.includes("responseerror('too many 429")
  );
}

/**
 * [서킷 브레이커 상태]
 * - 429가 연속으로 발생하면 일정 시간 동안 호출 자체를 막아 구글을 덜 자극
 */
const circuit = {
  consecutive429: 0,
  openUntilMs: 0
};

/** 서킷 오픈 여부 */
function isCircuitOpen() {
  return Date.now() < circuit.openUntilMs;
}

/** 429 누적 시 서킷 오픈(쿨다운) */
function openCircuit() {
  // 연속 429가 많을수록 더 길게 쉼 (최대 30분)
  const base = 2 * 60 * 1000; // 2분
  const extra = Math.min(circuit.consecutive429, 10) * 2 * 60 * 1000; // 최대 +20분
  const cooldown = Math.min(base + extra, 30 * 60 * 1000);
  circuit.openUntilMs = Date.now() + cooldown;

  console.warn(
    `[trend] 🚧 Circuit OPEN: consecutive429=${circuit.consecutive429}, cooldownMs=${cooldown}`
  );
}

/** 성공/비429 에러 시 회복 */
function closeCircuit() {
  circuit.consecutive429 = 0;
  circuit.openUntilMs = 0;
}

/**
 * ISO 8601 Duration (예: PT1M20S)을 초 단위 숫자로 변환
 */
function parseIsoDurationToSec(iso) {
  const m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3600 + min * 60 + s;
}

/**
 * [함수 책임] python(pytrends)로 후보 트렌드를 "1회" 수집합니다.
 * @param {{region:string, days:number}} args
 * @returns {Promise<string>} stdout 문자열(JSON)
 */
function runPytrendsOnce(args) {
  const script = path.resolve("services/trend-service/pytrends_fetch.py");
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  return new Promise((resolve, reject) => {
    const p = spawn(pythonCmd, [script, "--region", args.region, "--days", String(args.days)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" }
    });

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d.toString("utf-8")));
    p.stderr.on("data", (d) => (err += d.toString("utf-8")));

    p.on("error", (e) => {
      const ex = new Error(`pytrends_fetch 프로세스 실행 실패: ${e?.message || e}`);
      ex.stderr = err;
      ex.cause = e;
      reject(ex);
    });

    p.on("close", (code) => {
      if (code !== 0) {
        const ex = new Error(`pytrends_fetch 실패(code=${code}): ${err}`);
        ex.exitCode = code;
        ex.stderr = err;
        reject(ex);
      } else {
        resolve(out);
      }
    });
  });
}

/**
 * [함수 책임] 429일 때만 지수 백오프 재시도 + 필요 시 서킷 오픈
 * @param {() => Promise<string>} fn
 * @param {{maxAttempts?:number, baseDelayMs?:number, maxDelayMs?:number}} opt
 * @returns {Promise<{ok:true, stdout:string, attempts:number} | {ok:false, reason:string, error:string, attempts:number}>}
 */
async function runWithRetry429(fn, opt = {}) {
  const maxAttempts = opt.maxAttempts ?? 6;      // 총 시도 횟수
  const baseDelayMs = opt.baseDelayMs ?? 5000;   // 1차 대기
  const maxDelayMs = opt.maxDelayMs ?? 5 * 60 * 1000; // 최대 5분 대기 캡

  // 서킷이 열려있으면 바로 실패 반환(서버는 살아있음)
  if (isCircuitOpen()) {
    const remain = circuit.openUntilMs - Date.now();
    return {
      ok: false,
      reason: "CIRCUIT_OPEN",
      error: `429 쿨다운 중입니다. 남은 시간(ms)=${remain}`,
      attempts: 0
    };
  }

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stdout = await fn();

      // 성공이면 서킷 회복
      closeCircuit();

      return { ok: true, stdout, attempts: attempt };
    } catch (e) {
      lastErr = e;
      const stderr = e?.stderr || "";
      const msg = e?.message || "";
      const is429 = isRateLimit429(stderr) || isRateLimit429(msg);

      if (!is429) {
        // 429가 아니면 재시도해도 의미 없는 경우가 많아서 즉시 종료
        closeCircuit();
        return {
          ok: false,
          reason: "PYTHON_FAILED",
          error: String(msg).slice(0, 4000),
          attempts: attempt
        };
      }

      // 429면 누적
      circuit.consecutive429 += 1;

      // 마지막 시도면 서킷 오픈 후 종료
      if (attempt === maxAttempts) {
        openCircuit();
        return {
          ok: false,
          reason: "RATE_LIMIT_429",
          error: String(msg).slice(0, 4000),
          attempts: attempt
        };
      }

      // 지수 백오프 + 지터
      const exp = Math.min(attempt, 10);
      let delay = baseDelayMs * 2 ** (exp - 1);
      delay = Math.min(delay, maxDelayMs);
      const jitter = Math.floor(Math.random() * 0.3 * delay); // 0~30%
      const waitMs = delay + jitter;

      console.warn(`[trend] 429 감지: attempt=${attempt}/${maxAttempts}, waitMs=${waitMs}`);
      await sleep(waitMs);
    }
  }

  // 여긴 사실상 안 탐
  openCircuit();
  return {
    ok: false,
    reason: "UNKNOWN",
    error: String(lastErr?.message || lastErr || "unknown").slice(0, 4000),
    attempts: maxAttempts
  };
}

/**
 * [함수 책임] python(pytrends)로 후보 트렌드를 수집합니다. (강건 버전)
 * @param {{region:string, days:number}} args
 * @returns {Promise<{region:string, days:number, items:Array<{date:string,keyword:string,traffic?:string}>, debug?:any}>}
 */
async function fetchTrendsFromPython(args) {
  const result = await runWithRetry429(() => runPytrendsOnce(args), {
    maxAttempts: Number(process.env.TRENDS_RETRY_MAX || 6),
    baseDelayMs: Number(process.env.TRENDS_RETRY_BASE_MS || 5000),
    maxDelayMs: Number(process.env.TRENDS_RETRY_MAX_DELAY_MS || 300000)
  });

  if (!result.ok) {
    // 서버는 절대 죽지 않게 빈 결과로 복구
    return {
      region: args.region,
      days: args.days,
      items: [],
      debug: {
        pythonOk: false,
        reason: result.reason,
        attempts: result.attempts,
        circuit: {
          consecutive429: circuit.consecutive429,
          openUntilMs: circuit.openUntilMs
        },
        error: result.error
      }
    };
  }

  // stdout JSON 파싱
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ...parsed,
      debug: {
        ...(parsed.debug || {}),
        pythonOk: true,
        attempts: result.attempts
      }
    };
  } catch {
    return {
      region: args.region,
      days: args.days,
      items: [],
      debug: {
        pythonOk: true,
        attempts: result.attempts,
        parseOk: false
      }
    };
  }
}

function parseTrafficToNumber(traffic) {
  if (!traffic || typeof traffic !== "string") return null;
  let t = traffic.trim().toUpperCase().replace("+", "");
  let mult = 1;
  if (t.endsWith("K")) {
    mult = 1000;
    t = t.slice(0, -1);
  } else if (t.endsWith("M")) {
    mult = 1000000;
    t = t.slice(0, -1);
  }
  const n = Number(t);
  return Number.isFinite(n) ? n * mult : null;
}

/**
 * [함수 책임] 규칙 기반 1차 필터(LLM 실패 대비)
 */
function ruleFilter(keyword) {
  const t = String(keyword).toLowerCase();
  const gambling = ["casino", "poker", "slot", "bet", "betting", "바카라", "도박", "카지노", "슬롯", "포커"];
  const politics = ["election", "president", "congress", "senate", "선거", "대통령", "국회", "정당", "정치"];
  if (gambling.some((w) => t.includes(w))) return false;
  if (politics.some((w) => t.includes(w))) return false;
  return true;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(new Error("유효하지 않은 JSON 형식입니다."));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // WHATWG URL로 파싱 (DEP0169 경고 원인 제거)
  const u = new URL(req.url, `http://${req.headers.host}`);

  // 어떤 예외가 터져도 서버 프로세스가 죽지 않게 전체를 감싼다
  try {
    // -------------------------------------------------------------------------
    // 1. [GET] 일간 트렌드 키워드 조회
    // -------------------------------------------------------------------------
    if (req.method === "GET" && u.pathname === "/trends/daily") {
      const region = String(u.searchParams.get("region") || "KR");
      const days = Number(u.searchParams.get("days") || 7);

      // (기존 로직 수행)
      const raw = await fetchTrendsFromPython({ region, days });

      // 디버깅 로그용: days, traffic 통계
      const trafficNums = (raw.items || [])
        .map((x) => parseTrafficToNumber(x.traffic))
        .filter((x) => typeof x === "number");

      const trafficMax = trafficNums.length ? Math.max(...trafficNums) : null;
      const trafficAvg = trafficNums.length
        ? Math.round(trafficNums.reduce((a, b) => a + b, 0) / trafficNums.length)
        : null;

      // 1차 규칙 기반 중복 제거 + 금지어 제거
      const seen = new Set();
      const candidates = [];
      for (const it of raw.items || []) {
        const kw = String(it.keyword || "").trim();
        if (!kw) continue;
        const key = kw.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!ruleFilter(kw)) continue;
        candidates.push({ keyword: kw, traffic: it.traffic || null, date: it.date });
      }

      // console.log는 객체를 문자열로 만들 때 [object Object] 되기 쉬워서 JSON으로
      console.log(`[Trend Debug] candidates(sample)=${JSON.stringify(candidates.slice(0, 5))}`);

      // 2차 LLM 필터링/우선순위
      const prompt = {
        role: "trend_keyword_ranker",
        region,
        days,
        inputCandidates: candidates.slice(0, 60),
        instructions: [
          "아래 후보 트렌드 키워드들 중에서 '도박/정치' 주제는 제외한다.",
          "Shorts 제작에 적합한 '대중성/바이럴 가능성'이 높은 순서로 정렬한다.",
          "동일 의미/중복 키워드는 하나로 합친다.",
          "결과는 keywords 배열로만 반환한다.",
          "최대 25개까지만 반환한다."
        ],
        outputFormat: { keywords: ["string", "string"] }
      };

      let keywords = [];
      let llmRaw = null;

      try {
        llmRaw = await llm.generateJson(prompt);
        const parsedJson = JSON.parse(llmRaw);
        keywords = Array.isArray(parsedJson.keywords) ? parsedJson.keywords.slice(0, 25) : [];
        console.log(
          `[LLM] ✅ 파싱 성공: keywords=${keywords.length}` +
          (keywords.length ? ` (sample="${keywords.slice(0, 5).join(", ")}")` : "")
        );
      } catch (err) {
        // LLM 실패 시 후보를 traffic 기반(있다면) + 입력순으로 fallback
        console.warn(`[LLM] ❌ 실패 → fallback 사용`, {
          name: err?.name,
          message: err?.message
        });

        const scored = candidates.map((c) => ({ ...c, trafficN: parseTrafficToNumber(c.traffic) ?? 0 }));
        scored.sort((a, b) => b.trafficN - a.trafficN);
        keywords = scored.map((x) => x.keyword).slice(0, 25);
      }

      // python이 실패/쿨다운이면 keywords가 비어 있을 수 있음 → 그래도 200으로 내려도 되고,
      // 호출자가 "이번 회차는 비어있다"를 구분해야 하면 503도 가능.
      // 여기서는: python 실패/쿨다운이면 503, 그 외 200
      const pythonOk = raw?.debug?.pythonOk !== false;
      const statusCode = pythonOk ? 200 : 503;

      return sendJson(res, statusCode, {
        region,
        days,
        keywords,
        debug: {
          rawItems: raw.items?.length || 0,
          candidates: candidates.length,
          trafficAvg,
          trafficMax,
          llmUsed: Boolean(llmRaw),
          python: raw.debug || null
        }
      });
    }

    // -------------------------------------------------------------------------
    // 2. [POST] 쿼리 구체화 (Query Engineering) 
    // -------------------------------------------------------------------------
    else if (req.method === "POST" && u.pathname === "/trends/refine") {
      const body = await parseJsonBody(req);
      const { keyword, tags, region = "US" } = body;

      const langMap = {
        'KR': '한국어(Korean)',
        'US': '영어(English)',
        'MX': '스페인어(Spanish)',
      };
      const targetLanguage = langMap[region] || '해당 지역의 공용어';

      if (!keyword || !tags) {
        return sendJson(res, 400, { error: "keyword와 tags 데이터가 필요합니다." });
      }

      console.log(`[QE] '${keyword}' 분석 시작 (태그 수: ${tags.length})`);
      console.log(`[QE] '${keyword}' 태그 샘플:`, tags.slice(0, 60));

      // SPF 전처리: Saturation Penalty 계산
      const sigma = 12;
      const processedTags = tags.map(t => ({
        tag: t.tag,
        f: t.TF,
        sat_penalty: Number(Math.exp(-(Math.pow(t.TF, 2)) / (2 * Math.pow(sigma, 2))).toFixed(4))
      })).slice(0, 150);

      const prompt = {
        role: "Senior_VPI_Query_Architect",
        context: `'${keyword}' 주제를 분석하여 ${targetLanguage} 시장을 타겟팅하는 3가지 상호 배타적 검색 쿼리를 생성하십시오.`,

        instructions: [
          "1. 수집된 태그를 분석하여 3개의 독자적인 군집(Positive Cluster)으로 분류하십시오. 이때 태그들 사이의 연관성을 분석하여 '지금 이 순간' 가장 뜨거운 이슈(밈, 뉴스, 사건, 특정 인물)를 우선적으로 군집화하십시오",
          "2. 각 군집의 검색 의도를 방해하거나 범용어로 선정된 '제외어 군집(Negative Cluster)'을 반드시 별도로 정의하십시오.", // ✅ 제외어 정의 지시 추가
          "3. 쿼리 작성 시: '핵심태그 2개' 정도만 사용하여 검색 범위를 확보하고, '제외어'를 통해 타 군집과의 중복을 제거하십시오.",
          //"3.1 쿼리 형식: '키워드 핵심태그1 핵심태그2 (2개 ~ 3개) -타군집태그1 -타군집태그2'",",
          "4. 3개의 슬롯은 반드시 서로 다른 시각(Angle)을 가져야 하며, 검색 결과가 겹치지 않아야 합니다."
        ],

        constraints: [
          "1. [언어] 모든 결과물은 **${targetLanguage}**로만 작성하십시오.",
          "2. [태그 선정] f(빈도)가 높으면서 sat_penalty가 0.3 이상인 '유효 정보 태그'를 우선 사용하십시오.",
          "3. [범용 태그 처리] f가 일정 이상 높은 범용 태그(예: vlog, 추천, 이슈, shorts 등)는 검색 결과 확보를 위해 **절대로 제외어(-)에 넣지 마십시오.**",
          // "4. [Cross-Exclusion] 제외어(-) 섹션에는 '다른 슬롯에서 선정한 핵심 태그'하나씩, 필요시 노이즈 키워드 만을 삽입하시오."
        ],

        outputFormat: {
          analysis: {
            clusters: [
              { name: "군집1 이름", logic: "선정 근거", identity_tags: ["군집1 핵심 태그들"] },
              { name: "군집2 이름", logic: "선정 근거", identity_tags: ["군집2 핵심 태그들"] },
              { name: "군집3 이름", logic: "선정 근거", identity_tags: ["군집3 핵심 태그들"] },
              { name: "범용/노이즈 태그", logic: "선정 근거", identity_tags: ["범용/노이즈 태그 태그들"] }
            ]
          },
          slots: [
            { q: "keyword 군집1tag1 군집1tag2 -군집2tag -군집3tag", theme: "군집1의 전문적 관점" },
            { q: "keyword 군집2tag1 군집2tag2 -군집1tag -군집3tag", theme: "군집2의 전문적 관점" },
            { q: "keyword 군집3tag1 군집3tag2 -군집1tag -군집2tag", theme: "군집3의 전문적 관점" }
          ]
        },

        // outputExample: {
        //   analysis: {
        //     clusters: [
        //       { name: "기술 성능 분석", logic: "수치 데이터와 벤치마크 위주 태그", identity_tags: ["성능", "벤치마크", "스펙"] },
        //       { name: "현지 발표", logic: "가격 및 출시일 등 실구매 정보", identity_tags: ["가격", "출시일", "사전예약"] },
        //       { name: "실사용 리뷰", logic: "실제 사용 환경 및 장단점", identity_tags: ["사용기", "장단점", "꿀팁"] }
        //     ]
        //   },
        //   slots: [
        //     {
        //       q: "iPhone16 성능 벤치마크 스펙 -가격 -사용기",
        //       theme: "하드웨어 성능 및 기술적 진보에 집중한 트렌드"
        //     },
        //     {
        //       q: "iPhone16 가격 출시일 사전예약 -성능 -사용기",
        //       theme: "구매 시점 및 비용 효율성을 중시하는 소비자 트렌드"
        //     },
        //     {
        //       q: "iPhone16 사용기 장단점 꿀팁 -성능 -가격",
        //       theme: "실제 사용자 경험과 라이프스타일 중심의 트렌드"
        //     }
        //   ]
        // }
      };
      const llmRaw = await llm.generateJson(prompt);
      return sendJson(res, 200, JSON.parse(llmRaw));
    }

    // -------------------------------------------------------------------------
    // 3. [POST] 쿼리 구체화 Video Clustering (Query Engineering)  
    // -------------------------------------------------------------------------
    else if (req.method === "POST" && u.pathname === "/trends/refine_vc") {
      // [신규 API] Video Clustering 기반 쿼리 구체화
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { keyword, region, recentDays } = JSON.parse(body);

          // 1. 국가코드 및 언어코드 맵핑
          const langCode = region === "KR" ? "ko" : region === "US" ? "en" : region === "MX" ? "es" : "en";
          const ytKey = process.env.YOUTUBE_API_KEY || "YOUR_YOUTUBE_API_KEY"; // 환경변수 확인 필요

          // 2. 유튜브 Search API 호출 (모수 50개 확보, relevanceLanguage 추가)                                                                     // order=relevance or order=date
          // const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&q=${encodeURIComponent(keyword)}&type=video&videoDuration=short&regionCode=${region}&relevanceLanguage=${langCode}&order=relevance&key=${ytKey}`;
          // 2. URL에 publishedAfter 파라미터 추가
          console.log(recentDays, typeof recentDays);
          const publishedAfter = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString(); // 최근 recentDays일
          const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&q=${encodeURIComponent(keyword)}&type=video&videoDuration=short&regionCode=${region}&relevanceLanguage=${langCode}&order=relevance&publishedAfter=${publishedAfter}&key=${ytKey}`;
          const searchRes = await fetch(searchUrl);
          const searchData = await searchRes.json();

          // 🔥 [추가] YouTube API 자체 에러 처리 (Quota Exceeded, Invalid Key 등)
          if (!searchRes.ok || searchData.error) {
            console.error(`[VC_SEARCH] 🚨 YouTube API 에러 발생:`, searchData.error);
            return sendJson(res, 200, {
              clusters: [],
              analysis: { reason: `YouTube API 실패: ${searchData.error?.message || "Unknown"}` },
              // 클라이언트의 PipelineRunner가 undefined를 띄우지 않도록 stats 객체 강제 포함
              stats: { totalSearched: 0, totalShorts: 0 }
            });
          }

          console.log(`[VC_SEARCH] Keyword: '${keyword}', Found: ${searchData.items?.length || 0} items`);
          if (!searchData.items || searchData.items.length === 0) {
            return sendJson(res, 200, { clusters: [], analysis: { reason: "검색 결과 없음" } });
          }

          const videoIds = searchData.items.map(it => it.id.videoId).join(',');

          // 2. 상세 정보(duration 포함) 조회를 위해 videos API 호출
          const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoIds}&key=${ytKey}`;
          const videoRes = await fetch(videoUrl);
          const videoData = await videoRes.json();

          // [로깅] 상세 정보 반환 개수 출력
          console.log(`[VC_VIDEOS] ID Fetch Result: ${videoData.items?.length || 0} items`);

          // 3. 파이프라인 정책에 맞는 '진짜 쇼츠' 필터링 (예: 60초 또는 80초 이하)
          // ISO 8601 duration(PT1M10S)을 초단위로 변환하는 간단한 함수 내장 필요
          const videoList = (videoData.items || [])
            .map(v => {
              const duration = v.contentDetails.duration;
              const sec = parseIsoDurationToSec(duration);
              return {
                videoId: v.id,
                title: v.snippet.title,
                description: v.snippet.description ? v.snippet.description.substring(0, 200).replace(/\n/g, " ") : "",
                channelTitle: v.snippet.channelTitle,
                viewCount: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
                durationSec: sec,
                channelId: v.snippet.channelId
              };
            })
            // [추가 필터] Pipeline 정책에 따라 일정 시간 이하만 LLM에게 전달 (예: 80초)
            .filter(v => v.durationSec > 0 && v.durationSec <= 80);

          console.log(`[VC_FILTER] Final Shorts Candidates after duration filter: ${videoList.length} items`);


          // 5. 정교한 프롬프트 디자인 (주제 + 영상 형식/장면 동시 고려)
          const prompt = `
            당신은 유튜브 영상 큐레이션 및 트렌드 분석 전문가입니다.
            다음은 '${keyword}' 키워드로 검색된 유튜브 영상들의 제목과 설명 데이터입니다.

            [요구사항]
            이 영상들을 의미론적 '주제'뿐만 아니라 "영상 형식/장면(Scene)"을 기준으로 3~4개의 군집(Cluster)으로 분류하세요.
            예를 들어, 같은 주제라도 '뉴스 데스크 공식 보도', '현지인 반응 및 인터뷰', '전문가 해설 및 교육', '개인 브이로그' 등 장면과 형식이 다르면 별도의 군집으로 분리해야 시각적 일관성이 유지됩니다.

            결과는 반드시 아래 JSON 형식으로만 반환하세요. (설명 금지, 마크다운 코드블록 금지)

            {
              "clusters": [
                {
                  "name": "군집 이름 (예: 미국 이란 위기 - 공식 뉴스 특보)",
                  "description": "이 군집의 주제와 시각적 형식에 대한 설명 (예: 앵커가 등장하는 공식 뉴스 채널들의 보도 영상 모음)",
                  "clusterLabel": "이 군집을 가장 잘 대표하는 파생 검색어 (10자 내외의 명사형)",
                  "videoIds": ["videoId1", "videoId2"]
                }
              ]
            }

            영상 데이터:
            ${JSON.stringify(videoList, null, 2)}
            `;

          const llmRaw = await llm.generateJson(prompt);
          const result = JSON.parse(llmRaw);

          // 반환할 클러스터 객체에 원본 영상 정보 매핑
          result.clusters.forEach(c => {
            c.videos = c.videoIds.map(id => videoList.find(v => v.videoId === id)).filter(Boolean);
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            clusters: result.clusters,
            analysis: {
              totalAnalyzed: videoData.items?.length || 0, // 상세 정보 조회 성공 수
              totalSearched: searchData.items?.length || 0, // 최초 검색 결과 수
              totalShorts: videoList.length,                // 시간 필터(80초) 통과 수
              region,
              keyword
            }
          }));
        } catch (err) {
          console.error("QE VC Error:", err);
          res.writeHead(500).end(JSON.stringify({ error: err.message }));
        }
      });
    }

    // -------------------------------------------------------------------------
    // 4. 404 Not Found
    // -------------------------------------------------------------------------
    else {
      return sendJson(res, 404, { error: "Not Found" });
    }

  } catch (e) {
    // [중요] 핸들러 내에서 발생하는 모든 예외를 여기서 캐치하여 서버 다운을 방지합니다.
    console.error("[trend-service] ❌ Unhandled Error:", e);
    return sendJson(res, 500, {
      error: "Internal Server Error",
      message: e.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`[trend-service] listening on http://localhost:${PORT}`);
});


