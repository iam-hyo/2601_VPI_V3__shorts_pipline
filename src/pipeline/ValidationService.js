/**
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

  /**
   * [메서드 책임]
   * - 키워드 후보를 순회하여 조건 만족하는 첫 키워드와 Top4 영상을 반환합니다.
   *
   * @param {{region:string, keywords:string[]}} args
   * @returns {Promise<{keyword:string, videos:Array<object>}>}
   */
  async pickKeywordAndTopVideos(args) {
    // VALIDATION.recentDays 이내 영상만 필터링 기준, config에서 정의
    const publishedAfterISO = new Date(Date.now() - VALIDATION.recentDays * 24 * 3600 * 1000).toISOString();

    // 키워드별 반복 시작
    for (const keyword of args.keywords) {
      // 검색결과 수 필터링
      const searched = await this.yt.searchVideos({ q: keyword, maxResults: 50, publishedAfterISO });
      if ((searched?.length || 0) < 6) continue; // 검색결과가 6보다 작으면 다음 키워드.

      const features = await this.yt.buildVideoFeatures({ videoIds: searched.map((s) => s.videoId), region: args.region });

      // 쇼츠 수 필터링
      const shortsCount = features.filter((f) => f.is_short === true).length;
      if (shortsCount < VALIDATION.minShortsCount) {
        log.info({ keyword, shortsCount }, "쇼츠 개수 부족 -> 다음 키워드");
        continue;
      }

      // 조회수 예측 API 호출
      const preds = await this.predictor.predictPred7(features);

      // 점수(Delta View)기준 선정기
      const scored = [];
      for (const p of preds) {
        const f = features.find((x) => x.id === p.id);
        if (!f) continue;

        const predicted7d = Number(p.predicted_7day_views ?? 0);
        const viewCount = Number(f.view_count ?? 0);

        // 조회수 하한 필터링 (50,000회)
        if (predicted7d < VALIDATION.minPredictedViews) continue;

        scored.push({
          videoId: p.id,
          title: f.title,
          channelTitle: f.channel_title,
          predicted7d,
          viewCount,
          delta: predicted7d - viewCount
        });
      }

      // 영상 갯수 팔터랑 확인 한번 더 
      if (scored.length < VALIDATION.minQualifiedVideos) {
        log.info({ keyword, qualified: scored.length }, "예측 기준 만족 영상 부족 -> 다음 키워드");
        continue;
      }

      // 정렬 후 반환 topK(4)개 만큼 반환
      scored.sort((a, b) => b.delta - a.delta);
      const top = scored.slice(0, VALIDATION.topK);

      log.info({ keyword, top: top.map((t) => ({ id: t.videoId, delta: t.delta })) }, "키워드 통과(Δ 상위 4개 선정)");
      return { keyword, videos: top };
    }

    throw new Error("후보 키워드 중 조건을 만족하는 키워드를 찾지 못했습니다.");
  }
}
