/**
 * [파일 책임]
 * - VPI Predictor API(배치)를 호출합니다.
 *
 * [요구사항 반영]
 * - 헤더는 Content-Type/Accept만 사용(인증 헤더 없음)
 */

export class VPIPredictorClient {
  /**
   * [생성자 책임] baseUrl/endpoint 설정
   * @param {{baseUrl:string, endpoint:string}} args
   */
  constructor(args) {
    this.baseUrl = (args.baseUrl || "").replace(/\/$/, "");
    this.endpoint = (args.endpoint || "/predict/pred7").startsWith("/") ? (args.endpoint || "/predict/pred7") : `/${args.endpoint}`;
  }

  /**
   * [메서드 책임] pred7 배치 예측 호출
   * @param {Array<object>} payload predictor request body 배열
   * @returns {Promise<Array<{id:string,predicted_7day_views:number,FI:number}>>}
   */
  async predictPred7(payload) {
    const url = `${this.baseUrl}${this.endpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`VPI Predictor 오류(${res.status}): ${text}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }
}
