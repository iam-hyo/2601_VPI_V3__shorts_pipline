/**
 * [파일 책임]
 * - Video Processor Service(API)를 호출하여 최종 편집 파일을 생성합니다.
 */

export class VideoProcessorApiClient {
  /**
   * [생성자 책임] baseUrl 설정
   * @param {{baseUrl:string}} args
   */
  constructor(args) {
    this.baseUrl = (args.baseUrl || "").replace(/\/$/, "");
  }

  /**
   * [메서드 책임] 비디오 프로세싱 요청
   * @param {{workDir:string, topic:string, sources:Array<{id:string,inputPath:string}>}} req
   * @returns {Promise<{ok:boolean, outputFileAbs?:string, outputFile?:string, uploadMeta?:any, error?:string}>}
   */
  async process(req) {
    const url = `${this.baseUrl}/process`;
    console.log(`🚀 Requesting to: ${url}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Video Processor API 오류(${res.status}): ${text}` };
    }

    return await res.json();
  }
}
