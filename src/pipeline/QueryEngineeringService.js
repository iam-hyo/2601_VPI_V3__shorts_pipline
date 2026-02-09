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

  generateSlots(keyword, analysis) {
    // LLM이 반환한 군집 데이터를 기반으로 q=대주제 Pivot|Alias -제외어 생성
    // (이 부분은 LLM 응답 구조에 맞춰 파싱 로직 구현)
    return analysis.slots.map(s => ({
      id: s.id,
      theme: s.theme,
      q: `${keyword} ${s.pivots.join('|')} -뉴스 -보도 -MBN`
    }));
  }
}