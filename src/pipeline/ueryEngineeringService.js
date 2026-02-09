// src/pipeline/QueryEngineeringService.js 
export class QueryEngineeringService {
  constructor(deps) {
    this.yt = deps.yt;
    this.llm = deps.llm; // Gemini API 연동부
  }

  async refineQuery(rawKeyword, region) {
    // 1. 원본 키워드로 50개 영상 검색 및 태그 추출
    const searchResults = await this.yt.searchVideos({ q: rawKeyword, maxResults: 50, region });
    const tags = await this.yt.getVideoTags(searchResults.map(v => v.videoId)); // 태그 수집 로직 필요

    // 2. LLM에게 군집화 및 SPF 점수 산정 요청 (앞서 만든 프롬프트 활용)
    const analysis = await this.llm.analyzeHashtags(tags); 

    // 3. 3개의 슬롯 쿼리 생성 (Hero, Action, Scene)
    const refinedSlots = this.generateTripleSlots(analysis);

    return { analysis, refinedSlots };
  }
}