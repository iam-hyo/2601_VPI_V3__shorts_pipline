/**
 * [파일 책임]
 * - video-processor-service에서 쓰는 LLM 래퍼(Wrapper)
 * - 서버 코드는 llm.generateJson(prompt)를 호출한다고 가정하므로,
 *   여기서 Gemini 범용 호출(generateContent)을 연결한다.
 *
 * [이 파일이 해결하는 문제]
 * 1) 서버는 "객체 프롬프트"를 만들고 싶다.
 * 2) Gemini 호출은 "문자열 프롬프트"로 보내는 게 안정적이다.
 * 3) Gemini는 가끔 ```json ... ``` 같은 코드펜스로 감싸서 응답한다.
 *    -> JSON.parse 하기 전에 정리해줘야 한다.
 */

import { generateContent } from "./gemini.service.js";

const MODEL = process.env.GEMINI_MODEL;

/**
 * [함수 책임]
 * - Gemini 결과에서 JSON만 안전하게 뽑아내어 반환한다.
 *
 * @param {string} raw
 * @returns {string} jsonString
 */
function normalizeJsonString(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  // 1) ```json ... ``` 또는 ``` ... ``` 코드펜스 제거
  const fenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  // 2) 문장 + JSON이 섞인 경우를 대비해, 첫 '{' ~ 마지막 '}'를 잘라내기
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  if (first >= 0 && last >= 0 && last > first) {
    return fenced.slice(first, last + 1).trim();
  }

  // 3) 그래도 없으면 원문 반환(호출부에서 fallback 처리)
  return fenced;
}

/**
 * [함수 책임]
 * - (객체) prompt를 LLM이 이해하기 쉬운 "문자열 프롬프트"로 변환한다.
 *
 * @param {any} promptObj
 * @returns {string}
 */
function buildPromptText(promptObj) {
  // 이미 문자열이면 그대로 사용
  if (typeof promptObj === "string") return promptObj;

  const topic = String(promptObj?.topic || "");
  const tasks = Array.isArray(promptObj?.task) ? promptObj.task : [];
  const outputFormat = promptObj?.outputFormat || {
    captions: ["string", "string", "string", "string"],
    uploadMeta: { title: "string", description: "string", tags: ["string"] },
  };

  // sources: title/channelTitle/description 등을 넣어주면 더 잘 뽑힘
  const sources = Array.isArray(promptObj?.sources) ? promptObj.sources : [];
  const sourceText = sources
    .slice(0, 4)
    .map((s, i) => {
      const title = String(s?.title || "");
      const channelTitle = String(s?.channelTitle || "");
      const desc = String(s?.description || "")
        .replace(/\s+/g, " ")
        .slice(0, 260);
      return [
        `#${i + 1}`,
        `title: ${title}`,
        `channel: ${channelTitle}`,
        `description: ${desc}`,
      ].join("\n");
    })
    .join("\n\n");

  return `
당신은 유튜브 쇼츠(Shorts) 콘텐츠 기획자이자 카피라이터입니다.
아래 정보(주제/참조영상)와 작업 지시사항을 바탕으로, "오로지 JSON"만 반환하세요.

[topic]
${topic}

[reference videos] (최대 4개)
${sourceText || "(no sources provided)"}

[tasks]
${tasks.map((t, i) => `- ${t}`).join("\n") || "- (no tasks provided)"}

[output rules]
- 반드시 JSON만 출력 (설명/잡담/마크다운 금지)
- captions는 길이 4의 배열
- 각 caption은 1~6 단어 정도의 짧은 영문 후킹 문구 권장
- uploadMeta.tags는 문자열 배열

[outputFormat schema]
${JSON.stringify(outputFormat, null, 2)}
  `.trim();
}

/**
 * [클래스 책임]
 * - 서버단에서 llm.generateJson(promptObj) 형태로 사용하기 위한 인터페이스 제공
 */
class LlmService {
  /**
   * [함수 책임]
   * - promptObj를 받아 Gemini로 JSON 결과를 생성해 "JSON 문자열"을 반환한다.
   * @param {any} promptObj
   * @returns {Promise<string>} JSON 문자열(정리된 상태)
   */
  async generateJson(promptObj) {
    if (!MODEL) {
      throw new Error("[llm] GEMINI_MODEL이 없습니다. 환경변수 GEMINI_MODEL을 설정하세요.");
    }

    const promptText = buildPromptText(promptObj);

    // ✅ isJson=true: Gemini에게 application/json으로 달라고 요청
    const raw = await generateContent(MODEL, promptText, true);

    // ✅ JSON.parse 안정성을 위해 최소한의 정리
    return normalizeJsonString(raw);
  }
}

// default export: 기존 서버 코드에서 `import llm from "./llm.js"` 하게끔
const llm = new LlmService();
export default llm;
