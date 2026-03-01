/**
 * src/pipeline/ValidationService.js
 * [파일 책임]
 * - 키워드 검증/선정 로직을 담당합니다.
 *
 * [로직 요약]
 * 1) keyword로 최근 5일 내 영상 50개 검색
 * 2) 쇼츠(<=60s) 개수 5개 이상인지 확인
 * 3) VPI Predictor(배치)로 predicted_7day_views - view_count(Δ) 계산
 * 4) predicted_7day_views >= 50k 를 만족하는 영상이 4개 이상인지 확인
 * 5) Δ 상위 4개를 최종 후보로 반환
 */

import { VALIDATION } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ValidationService");

export class ValidationService {
  /**
   * [생성자 책임] 의존성 주입
   * @param {{yt:any, predictor:any}} deps
   */
  constructor(deps) {
    this.yt = deps.yt;
    this.predictor = deps.predictor;
  }

  // =========================================
  /**
 * [리팩토링] 단일 쿼리에 대한 적합성 검증 수행
 * 기존 pickKeywordAndTopVideos의 내부 로직을 분리하여 재사용성을 높임
 */
  async validateSingleQuery({ q, region, slot }) {
    const publishedAfterISO = new Date(Date.now() - VALIDATION.recentDays * 24 * 3600 * 1000).toISOString();
    log.info(`[${region}_${slot}] 쿼리 적합성 검사: ${q}`);

    // 1) 검색 수행
    const searched = await this.yt.searchVideos({ q, maxResults: 50, publishedAfterISO, region });
    if ((searched?.length || 0) < VALIDATION.minShortsCount) {
      return {
        ok: false,
        reason: `검색 결과 부족 (검색됨: ${searched?.length || 0}개 / 최소 필요: ${VALIDATION.minShortsCount}개)`
      };
    }

    // 2) 특징치 추출 및 쇼츠 필터링
    const features = await this.yt.buildVideoFeatures({ videoIds: searched.map(s => s.videoId), region });
    const filteredFeatures = features.filter(f => f.is_short === true);

    if (filteredFeatures.length < VALIDATION.minShortsCount) {
      return { ok: false, reason: `쇼츠 개수 부족 (적합: ${filteredFeatures.length}개 / 최소: ${VALIDATION.minShortsCount}개)` };
    }

    // 3) 조회수 예측 및 점수화
    const preds = await this.predictor.predictPred7(filteredFeatures);
    const scored = [];
    for (const p of preds) {
      const f = filteredFeatures.find(x => x.id === p.id);
      if (!f) continue;

      const predicted7d = Number(p.predicted_7day_views ?? 0);
      if (predicted7d < VALIDATION.minPredictedViews) continue;

      scored.push({
        videoId: p.id,
        title: f.title,
        channelTitle: f.channel_title,
        predicted7d,
        viewCount: Number(f.view_count ?? 0),
        delta: predicted7d - Number(f.view_count ?? 0)
      });
    }

    if (scored.length < VALIDATION.minQualifiedVideos) {
      return { ok: false, reason: `조회수 조건 미달 (조건만족: ${scored.length}개 / 최소: ${VALIDATION.minQualifiedVideos}개)` };
    }

    scored.sort((a, b) => b.delta - a.delta);
    return { ok: true, videos: scored.slice(0, VALIDATION.topK) };
  }
}
