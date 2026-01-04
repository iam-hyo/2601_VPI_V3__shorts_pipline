/**
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
import url from "node:url";
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

/**
 * [함수 책임] python(pytrends)로 후보 트렌드를 수집합니다.
 * @param {{region:string, days:number}} args
 * @returns {Promise<{region:string, days:number, items:Array<{date:string,keyword:string,traffic?:string}>}>}
 */
async function fetchTrendsFromPython(args) {
  const script = path.resolve("services/trend-service/pytrends_fetch.py");
  // Windows라면 'python', 그 외(Linux/Mac)라면 'python3' 사용
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  const stdout = await new Promise((resolve, reject) => {
    // python3 대신 pythonCmd 변수 사용
    const p = spawn(pythonCmd, [script, "--region", args.region, "--days", String(args.days)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" }
    });

    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString("utf-8")));
    p.stderr.on("data", (d) => (err += d.toString("utf-8")));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`pytrends_fetch 실패(code=${code}): ${err}`));
      else resolve(out);
    });
  });

  try {
    return JSON.parse(stdout);
  } catch {
    return { region: args.region, days: args.days, items: [] };
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "GET" && parsed.pathname === "/trends/daily") {
    const region = String(parsed.query.region || "KR");
    const days = Number(parsed.query.days || 7);

    const raw = await fetchTrendsFromPython({ region, days });

    // 디버깅 로그용: days, traffic 통계
    const trafficNums = raw.items
      .map((x) => parseTrafficToNumber(x.traffic))
      .filter((x) => typeof x === "number");

    const trafficMax = trafficNums.length ? Math.max(...trafficNums) : null;
    const trafficAvg = trafficNums.length ? Math.round(trafficNums.reduce((a, b) => a + b, 0) / trafficNums.length) : null;

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

    console.log(`[Trend Debug] 결과내용: ${candidates.slice(0, 5)}`)

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
    } catch {
      // LLM 실패 시 후보를 traffic 기반(있다면) + 입력순으로 fallback
      console.warn(`[LLM] ❌ 실패 → fallback 사용`, {
        name: err?.name,
        message: err?.message,
      });

      const scored = candidates.map((c) => ({ ...c, trafficN: parseTrafficToNumber(c.traffic) ?? 0 }));
      scored.sort((a, b) => b.trafficN - a.trafficN);
      keywords = scored.map((x) => x.keyword).slice(0, 25);
    }

    return sendJson(res, 200, {
      region,
      days,
      keywords,
      debug: {
        rawItems: raw.items?.length || 0,
        candidates: candidates.length,
        trafficAvg,
        trafficMax,
        llmUsed: Boolean(llmRaw)
      }
    });
  }

  return sendJson(res, 404, { error: "Not Found" });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[trend-service] listening on http://localhost:${PORT}`);
});
