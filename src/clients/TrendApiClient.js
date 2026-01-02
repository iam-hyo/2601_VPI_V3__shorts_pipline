/**
 * [파일 책임]
 * - Trend Service(API)를 호출하여 keywords를 가져옵니다.
 */

export class TrendApiClient {
  /**
   * [생성자 책임] baseUrl 설정
   * @param {{baseUrl:string}} args
   */
  constructor(args) {
    this.baseUrl = (args.baseUrl || "").replace(/\/$/, "");
  }

  /**
   * [메서드 책임] 일간 트렌드 키워드(LLM 필터/우선순위 반영) 조회
   * @param {{region:string, days?:number}} args
   * @returns {Promise<string[]>}
   */
  async getDailyTrends(args) {
    const days = args.days ?? 7;
    const url = `${this.baseUrl}/trends/daily?region=${encodeURIComponent(args.region)}&days=${days}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Trend API 오류(${res.status}): ${text}`);
    }
    const data = await res.json();

    if (!data.keywords || data.keywords.length === 0) {
      console.warn(`[DEBUG] 서버 응답은 정상이지만 키워드가 비어있습니다. URL: ${url}`);
    }

    return Array.isArray(data?.keywords) ? data.keywords : [];
  }
}
