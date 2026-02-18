// src/pipeline/QueryEngineeringService.js
import { createLogger } from "../utils/logger.js";

const log = createLogger("QueryEngineeringService");

export class QueryEngineeringService {
  constructor(deps) {
    this.yt = deps.yt;
    this.gemini = deps.gemini; // Gemini API 연동 모듈 (가정) ⭐⭐⭐
  }

  async execute(rawKeyword, region) {
    log.info(`'${rawKeyword}' 쿼리 구체화 시작...`);

    // 1. 데이터 수집
    const searched = await this.yt.searchVideos({ q: rawKeyword, maxResults: 50, region });
    const videoIds = searched.map(v => v.videoId);
    const rawTags = await this.yt.collectHashtags(videoIds);

    // 2. 수식 전처리 (Saturation Penalty 계산)
    const sigma = 12;
    const processedTags = rawTags.map(t => ({
      ...t,
      sat_penalty: Math.exp(-(Math.pow(t.TF, 2)) / (2 * Math.pow(sigma, 2)))
    })).slice(0, 100); // 상위 100개만 LLM에 전달

    // 3. LLM 분석 요청 (CoT 프롬프트 적용)
    const analysis = await this.gemini.analyzeForQE(rawKeyword, processedTags);

    // 4. 3개 슬롯 쿼리 생성 (Pivot-Expansion 로직)
    const slots = this.generateSlots(rawKeyword, analysis);

    return { analysis, slots };
  }

  enerateSlots(keyword, analysis) {
    return analysis.slots.map(s => {
      // 1. 피벗 키워드들만 추출 (괄호나 특수문자 제거)
      const cleanPivots = s.pivots.map(p => p.replace(/[()]/g, '').trim());

      // 2. 검색 쿼리 조립 (그룹화 적용)
      // 검색어 예: "america vs chivas" (historia|rivalidad) -news
      const query = `"${keyword}" (${cleanPivots.join('|')})`;

      return {
        id: s.id,
        theme: s.theme, // 테마 정보는 UI용이나 로그용으로만 유지
        q: query        // 실제 API로 날아가는 순수 쿼리
      };
    });
  }
}