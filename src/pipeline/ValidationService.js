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
    if ((searched?.length || 0) < 4) return null;

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
  // =================수정 끝=======================


  /**
   * - 키워드 후보를 순회하여 조건 만족하는 첫 키워드와 Top4 영상을 반환합니다.
   * @param {{region:string, keywords:string[]}} args
   * @returns {Promise<{keyword:string, videos:Array<object>}>}
   */
  async pickKeywordAndTopVideos(args) {
    const { keywords, assignedKeywords, region, slot } = args
    // VALIDATION.recentDays 이내 영상만 필터링 기준, config에서 정의
    const publishedAfterISO = new Date(Date.now() - VALIDATION.recentDays * 24 * 3600 * 1000).toISOString();
    const total = args.keywords.length;

    // 키워드별 반복 시작
    for (const [i, keyword] of keywords.entries()) {
      log.info(`[${args.region}_${slot}] '${keyword}' 적합도 검사 시작 ${i + 1}/${total}`)
      if (assignedKeywords.includes(keyword)) {
        log.warn(`[${args.region}_${slot}] '${keyword}는 이미 점유되었습니다.다음으로 넘어갑니다.'  ${i + 1}/${total}`)
        continue;
      }
      const searched = await this.yt.searchVideos({ q: keyword, maxResults: 50, publishedAfterISO, region: region });
      if ((searched?.length || 0) < 4) continue; // 검색결과가 4보다 작으면 다음 키워드.

      const features = await this.yt.buildVideoFeatures({ videoIds: searched.map((s) => s.videoId), region: args.region });

      // 1. 원본 features에서 '쇼츠'이면서 '80초 이하'인 영상만 추출하여 덮어쓰기
      const filteredFeatures = features.filter((f) => {
        const isShort = f.is_short === true;
        return isShort;
      });

      // 쇼츠 수 필터링
      const shortsCount = filteredFeatures.length;
      if (shortsCount < VALIDATION.minShortsCount) {
        log.info(`[${args.region}_${slot}] '⛔${keyword}' 적합한 쇼츠 개수 부족 (${shortsCount}개)`);
        continue; // 다음 키워드로 넘어감
      }
      log.info(`[${args.region}_${slot}] '${keyword}' 쇼츠 적합성 통과 (${shortsCount}개)`);

      // 조회수 예측 API 호출
      const preds = await this.predictor.predictPred7(filteredFeatures);

      // 점수(Delta View)기준 선정기
      const scored = [];
      for (const p of preds) {
        const f = filteredFeatures.find((x) => x.id === p.id);
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

      // 영상 정렬
      scored.sort((a, b) => b.delta - a.delta);

      const topPred7 = scored.slice(0, 4).map(s => s.predicted7d).join(', ');
      log.info(
        { pred7: topPred7 },
        `[${args.region}_${slot}] '${keyword}' 7일차 조회수 ${VALIDATION.minPredictedViews}회 이상 ${scored.length}개`
      );


      // 필터링된 영상 갯수 제한 확인
      if (scored.length < VALIDATION.minQualifiedVideos) {
        log.info(`[${args.region}_${slot}] '⛔${keyword}'조건을 만족하는 영상(${scored.length}개) => 다음 키워드 시도`)
        continue;
      }

      // 정렬 후 반환 topK(4)개 만큼 반환
      const top = scored.slice(0, VALIDATION.topK);

      log.info({ deltas: top.map(t => t.delta).join(', ') },
        `[${args.region}_${slot}] '${keyword}' 키워드 통과(Δ 상위 4개 선정)`);

      return { keyword, videos: top };
    }

    throw new Error("후보 키워드 중 조건을 만족하는 키워드를 찾지 못했습니다.");
  }
}
