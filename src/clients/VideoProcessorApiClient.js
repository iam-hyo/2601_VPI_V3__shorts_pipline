/**
 * ./src/VideoProcessorApiClient.js
 * - Video Processor Service(API)를 호출하여 최종 편집 파일을 생성합니다.
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("VideoProcessorApiClient");

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
   * @param {{workDir:string, topic:string, sources:Array<{id:string,inputPath:string}, slotID:string >}} req
   * @returns {Promise<{ok:boolean, outputFileAbs?:string, outputFile?:string, uploadMeta?:any, error?:string}>}
   */
  async process(req) {
    // 호출부: process({ workDir, topic: picked.keyword, slotID, HIGHLIGHT_SECOND, region }),
    const { slotID, topic, sources = [], region } = req; // 구조 분해 할당으로 변수 추출
    
    // console.log(`[${slotID}] 📤 process 호출 (req: ${JSON.stringify(req, null, 2)})`); // 호출 로그 추가
    // console.log(`[${slotID}] 📤 process 호출 (Region: ${region})`); // 호출 로그 추가
    const url = `${this.baseUrl}/process`;

    // 10분(600,000ms) 타임아웃 설정
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);

    log.info({ slotID, topic, sourceCount: sources?.length }, `📹 비디오 제작 요청 시작: ${topic}`);

    try {
      const startTime = Date.now();
      
      // 서버로 제작 요청
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: controller.signal // 신호 전달
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const errorMsg = `Video Processor API 오류(${res.status}): ${text}`;

        // 2. HTTP 에러 로그
        log.error({ slotID, status: res.status, error: text }, "❌ 비디오 제작 API 호출 실패");
        return { ok: false, error: errorMsg };
      }

      const result = await res.json();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1); // 소요 시간(초)

      // 3. 성공 로그 (소요 시간 및 결과 파일 정보 포함)
      log.info(
        { slotID, duration: `${duration}s`, outputFile: result.outputFile },
        `✅ 비디오 제작 완료 (${duration}초 소요)`
      );

      return result;

    } catch (err) {
      // 4. 네트워크 에러 또는 타임아웃 로그
      const isTimeout = err.name === 'AbortError';
      log.error(
        { slotID, error: err.message, isTimeout },
        isTimeout ? "⏱️ 비디오 제작 타임아웃 발생 (10분 초과)" : "❌ 비디오 제작 중 예외 발생"
      );

      return { ok: false, error: err.message };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
