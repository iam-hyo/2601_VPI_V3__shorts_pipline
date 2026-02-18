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

dotenv.config({ path: path.resolve(process.cwd(), "services/trend-service/.env") });
console.log("[DEBUG] TREND_SERVICE_PORT raw =", JSON.stringify(process.env.TREND_SERVICE_PORT));
const PORT = Number(process.env.TREND_SERVICE_PORT);

const llm = new GeminiClient({
  model: process.env.GEMINI_MODEL || "gemini-1.5-pro",
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

      // SPF 전처리: Saturation Penalty 계산
      const sigma = 12;
      const processedTags = tags.map(t => ({
        tag: t.tag,
        f: t.TF,
        sat_penalty: Number(Math.exp(-(Math.pow(t.TF, 2)) / (2 * Math.pow(sigma, 2))).toFixed(4))
      })).slice(0, 150); // 상위 150개 태그까지만 사용

      const prompt = {
        role: "expert_youtube_query_engineer",
        context: `'${keyword}'라는 주제를 분석하여, ${targetLanguage} 시장에 최적화된 3가지 세부 검색 쿼리를 생성하십시오.`,
        input: {
          base_trend: keyword,
          collected_tags: processedTags
        },
        instructions: [
          `1. [언어 원칙] 모든 출력 결과(analysis 내 설명, theme, q)는 **${targetLanguage}**로만 작성하십시오.`,
          "1.1. 지시문이 한국어라 하더라도 tag에 포함되어 있지 않다면 결과물에 한국어를 섞지 마십시오. (단, tag에 포함되어 있는경우 사용 가능, K-POP 등 고유 명사는 예외)",

          "2. [군집 분석] 수집된 태그를 바탕으로 의미론적 군집(예: 뉴스/이슈, 인물/관계, 기술/튜토리얼, 비하인드 등)을 3~4개 식별하십시오.",

          "3. [쿼리 설계 - 필수] 각 슬롯의 'q' 필드는 반드시 '핵심어|확장어1|확장어2' 형식을 엄수하십시오.",
          "3.1. 유튜브 쿼리용으로, 단어 사이를 공백이 아닌 **세로 바(|)**로 구분하는 것이 핵심입니다.",
          "3.2. 형식 예시: 'Donovan Carrillo|Patinaje|Juegos Olímpicos|Rutina'",

          "4. [노이즈 필터링] 주제와 무관한 스팸, 단순 채널명, 의미 없는 문자열은 각 쿼리 뒤에 '-'를 붙여 최대 3개까지 제외하십시오.",
          "4.1. 단, '공식 뉴스'나 '방송사' 태그가 해당 주제에서 유익한 정보원이라 판단되면 제외하지 말고 유지하십시오.",
          "4.2. 예시: '핵심어|확장어 -스팸단어 -채널명'",

          "5. [차별화] 각 슬롯은 서로 중복되지 않는 독자적인 관점(Angle)을 가져야 합니다."
        ],
        outputFormat: {
          analysis: { target_language_confirmed: "string", clusters: [{ name: "string", logic: "string" }] },
          slots: [{ id: "number", theme: "string", q: "string" }]
        }
      };

      const llmRaw = await llm.generateJson(prompt);
      return sendJson(res, 200, JSON.parse(llmRaw));
    }

    // -------------------------------------------------------------------------
    // 3. 404 Not Found
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
