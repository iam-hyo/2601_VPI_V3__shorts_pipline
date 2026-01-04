/**
 * [파일 책임]
 * - Gemini 호출 + API Key 로테이션을 제공합니다.
 *
 * [로테이션 규칙]
 * - 429 / RESOURCE_EXHAUSTED / quota 관련 에러면 다음 키로 자동 전환합니다.
 */

export class GeminiClient {
  /**
   * @param {{model:string, apiKeyPrefix?:string}} args
   */
  constructor(args) {
    this.model = args.model;
    this.apiKeyPrefix = args.apiKeyPrefix || "GEMINI_API_";
    this.keys = this._loadKeys();
  }

  _loadKeys() {
    const keys = [];

    // GEMINI_API_ 로 시작하는 환경변수 모두 탐색
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith(this.apiKeyPrefix)) continue;
      if (!value || !String(value).trim()) continue;

      keys.push(String(value).trim());
    }

    // (선택) 이름에 들어있는 번호(01,02,...) 기준 정렬하고 싶으면:
    keys.sort(); // 단순 정렬(원하면 더 정교하게 정렬 로직도 가능)
    console.log(`[GeminiClient] Gemini Key: ${keys.length}개 반환`)
    return keys;
  }

  /**
   * [메서드 책임] JSON 응답을 요구하는 Gemini 호출
   * @param {any} promptObj
   * @returns {Promise<string>} LLM 원문(text)
   */
  async generateJson(promptObj) {
    const prompt = typeof promptObj === "string" ? promptObj : JSON.stringify(promptObj, null, 2);
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.13,
        maxOutputTokens: 8192,
        responseMimeType: "application/json"
      }
    };

    if (!this.keys.length) throw new Error("GEMINI_API_KEY_01..N이 설정되지 않았습니다.");

    let lastErr = null;
    for (let idx = 0; idx < this.keys.length; idx++) {
      const apiKey = this.keys[idx];
      try {
        return await this._callOnce(apiKey, body);
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.toLowerCase().includes("quota")) {
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error("Gemini 호출 실패(모든 키 소진)");
  }

  async _callOnce(apiKey, body) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const msg = detail?.error?.message || res.statusText;
      throw new Error(`Gemini API 오류(${res.status}): ${msg}`);
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
}
