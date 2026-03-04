/**
 * [파일 책임]
 * - Google Gemini REST API를 "범용"으로 호출하는 유틸 서비스
 * - 목표: 다른 서비스(캡션 생성, 업로드 메타 생성 등)에서 공통으로 재사용
 *
 * [필수 환경변수]
 * - GEMINI_API_KEY: Google AI Studio / Generative Language API Key
 *
 * [권장 환경변수]
 * - GEMINI_MODEL: 예) gemini-3.1-flash-lite-preview, gemini-1.5-pro 등
 *
 * [주의]
 * - 이 함수는 "문자열"을 반환합니다. (JSON 모드여도 문자열)
 * - 호출부에서 JSON.parse() 또는 안전 파싱을 수행하세요.
 *
 * [런타임 요구]
 * - Node.js 18+ (global fetch 사용) 권장
 *   Node 18 미만이면 node-fetch 같은 폴리필이 필요합니다.
 */

const API_KEY = process.env.GEMINI_API_01_ILL2;

/**
 * [함수 책임]
 * - Gemini API에 프롬프트를 전달하고 생성 결과 텍스트를 반환한다.
 *
 * @param {string} model - Gemini 모델명 (예: 'gemini-3.1-flash-lite-preview')
 * @param {string|object} prompt - 문자열 또는 객체(객체면 JSON.stringify 후 전달)
 * @param {boolean} isJson - true면 responseMimeType을 application/json으로 요청
 * @returns {Promise<string>} - Gemini가 반환한 텍스트(대부분 JSON 문자열)
 */
export async function generateContent(model, prompt, isJson = false) {
  if (!API_KEY) {
    throw new Error("[gemini] GEMINI_API_KEY가 없습니다. 환경변수 GEMINI_API_KEY를 설정하세요.");
  }
  if (!model) {
    throw new Error("[gemini] model이 없습니다. 환경변수 GEMINI_MODEL 또는 호출 인자를 확인하세요.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // 프롬프트가 객체라면 보기 좋게 JSON 텍스트로 변환 (Gemini가 구조를 이해하기 쉬움)
  const safePrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt, null, 2);

  const body = {
    contents: [{ parts: [{ text: safePrompt }] }],
    generationConfig: {
      temperature: 0.13,
      maxOutputTokens: 8192,
      ...(isJson ? { responseMimeType: "application/json" } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });

  // 에러면: 상세 body까지 최대한 로그로 남기고 throw
  if (!res.ok) {
    const errorDetail = await res.json().catch(() => ({}));
    // eslint-disable-next-line no-console
    console.error("❌ Gemini API 상세 에러:", JSON.stringify(errorDetail, null, 2));
    throw new Error(`Gemini API 오류(${res.status}): ${errorDetail?.error?.message || res.statusText}`);
  }

  const data = await res.json();

  const candidate = data?.candidates?.[0];
  if (candidate) {
    // eslint-disable-next-line no-console
    console.log(`📌 Finish Reason: ${candidate.finishReason}`);
    if (candidate.finishReason === "MAX_TOKENS") {
      // eslint-disable-next-line no-console
      console.warn("⚠️ 경고: 출력 토큰 제한에 도달하여 JSON이 잘렸을 수 있습니다.");
    } else if (candidate.finishReason === "SAFETY") {
      // eslint-disable-next-line no-console
      console.warn("⚠️ 경고: 안전 정책(필터링)으로 인해 응답이 차단되었습니다.");
    }
  }

  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
