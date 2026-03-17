/**
 * src/pipeline/ValidationService.js
 * [파일 책임]
 * - 키워드 검증/선정 로직을 담당합니다.
 *
 * [로직 요약]
 * 1) keyword로 최근 5일 내 영상 50개 검색
 * 2) 쇼츠(<=60s) 개수 5개 이상인지 확인
 * 3) VPI Predictor(배치)로 pred - view_count(Δ) 계산
 * 4) pred >= 50k 를 만족하는 영상이 4개 이상인지 확인
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
    const searched = await this.yt.searchVideos({ q, maxResults: 50, publishedAfterISO, region }); //최신순
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

      const predicted7d = Number(p.pred ?? 0);
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
      return { ok: false, reason: `조회수 조건 미달 (조건만족: ${scored.length}개 / 최소 필요: ${VALIDATION.minQualifiedVideos}개)` };
    }

    scored.sort((a, b) => b.delta - a.delta);
    const finalVideos = scored.slice(0, VALIDATION.targetVideoCount);

    return {
      ok: true,
      videos: finalVideos,
      count: finalVideos.length // 실제 담긴 개수를 명시적으로 전달
    };
  }

  /**
   * [신규] Cluster 내 비디오 목록을 그대로 검증 (재검색 안함)
   * 로깅을 위해 실패하더라도 산출된 pred7 스코어 객체를 반환합니다.
   */
  async validateCluster({ clusterVideos, region }) {
    const videoIds = clusterVideos.map(v => v.videoId);
    if (videoIds.length < VALIDATION.minShortsCount) {
      return { ok: false, reason: `군집 내 영상 수 부족 (${videoIds.length}개)`, scored: [] };
    }

    // 1. 영상 특징치 빌드 및 쇼츠 필터링
    const features = await this.yt.buildVideoFeatures({ videoIds, region });
    const filteredFeatures = features.filter(f => f.is_short === true);

    if (filteredFeatures.length < VALIDATION.minShortsCount) {
      return { ok: false, reason: `군집 내 쇼츠 개수 부족 (${filteredFeatures.length}개)`, scored: [] };
    }

    // 2. 조회수 예측 API 호출
    const preds = await this.predictor.predictPred7(filteredFeatures);

    const scored = [];
    for (const p of preds) {
      const f = filteredFeatures.find(x => x.id === p.id);
      if (!f) continue;

      const predicted7d = Number(p.pred ?? 0);
      scored.push({
        videoId: p.id,
        title: f.title,
        channelTitle: f.channel_title,
        predicted7d,
        viewCount: Number(f.view_count ?? 0),
        delta: predicted7d - Number(f.view_count ?? 0)
      });
    }

    // pred7 내림차순 정렬 (로깅에서 상위 6개를 뽑기 위함)
    scored.sort((a, b) => b.predicted7d - a.predicted7d);

    // 검증 통과 필터링
    const qualified = scored.filter(s => s.predicted7d >= VALIDATION.minPredictedViews);

    if (qualified.length < VALIDATION.minQualifiedVideos) {
      return { ok: false, reason: `조회수 조건 미달 (조건만족: ${qualified.length}개)`, scored };
    }

    // 최종 통과시 topK 반환
    return { ok: true, videos: qualified.slice(0, VALIDATION.topK), scored };
  }

  async validateCluster4ViewCount({ clusterVideos, region, slot }) {
    log.info(`[${region}_${slot}] 🔍 군집 검증 시작 (입력: ${clusterVideos?.length || 0}개)`);

    const MIN_VIEW_COUNT = 70000;
    const MIN_QUALIFIED = 3; // 3개만 있어도 제작 가능하도록 완화된 기준 적용
    const scored = [];

    for (const v of clusterVideos) {
      const viewCount = Number(v.viewCount || v.view_count || 0);
      if (viewCount >= MIN_VIEW_COUNT) {
        scored.push({
          videoId: v.videoId || v.id,
          title: v.title,
          channelTitle: v.channelTitle || v.channel_title,
          predicted7d: viewCount,
          viewCount: viewCount,
          delta: viewCount
        });
      }
    }

    // 조회수 내림차순 정렬
    scored.sort((a, b) => b.viewCount - a.viewCount);

    const isOk = scored.length >= MIN_QUALIFIED;

    return {
      ok: isOk,
      videos: scored, // 발견된 모든 적합 영상 반환 (이후 동적 슬라이싱)
      scored: scored, // 로깅용 전체 데이터
      reason: isOk ? "검증 통과" : `조회수 7만 이상 영상 부족 (발견: ${scored.length}개 / 최소: ${MIN_QUALIFIED}개)`
    };
  }
}


