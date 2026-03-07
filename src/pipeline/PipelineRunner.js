/**
 * src/pipeline/PipelineRunner.js
 * [파일 책임]
 * - Resume/상태관리/재시도/서비스 호출을 모두 담당합니다.
 * - Orchestrator는 이 클래스만 호출하도록 유지하여 가독성을 극대화합니다.
 */

import path from "node:path";
import { ensureDir, writeJsonAtomic } from "../utils/fs.js";
import { withRetry } from "../utils/retry.js";
import { createLogger } from "../utils/logger.js";
import { TrendApiClient } from "../clients/TrendApiClient.js";
import { YouTubeClient } from "../clients/YouTubeClient.js";
import { VPIPredictorClient } from "../clients/VPIPredictorClient.js";
import { ValidationService } from "./ValidationService.js";
import { VideoProcessorApiClient } from "../clients/VideoProcessorApiClient.js";
import { YouTubeUploader } from "../clients/YouTubeUploader.js";
import { HIGHLIGHT_SECOND } from "../config.js";
import fs from "node:fs";

const log = createLogger("PipelineRunner");

function isDone(s) {
  return s === "DONE" || s === "SKIPPED";
}

export class PipelineRunner {
  /**
   * [생성자 책임] 필요한 클라이언트/서비스를 구성합니다.
   * @param {{env:object, paths:object, store:any}} args
   */
  constructor(args) {
    // console.log("DEBUG: PipelineRunner가 받은 env 전체 목록:", Object.keys(args.env));
    this.env = args.env;
    this.paths = args.paths;
    this.store = args.store;

    this.trendApi = new TrendApiClient({ baseUrl: args.env.TREND_API_BASE_URL });
    this.yt = new YouTubeClient({ apiKey: args.env.YOUTUBE_API_KEY });
    this.predictor = new VPIPredictorClient({
      baseUrl: args.env.VPI_PREDICTOR_BASE_URL,
      endpoint: args.env.VPI_PREDICTOR_ENDPOINT
    });
    this.validator = new ValidationService({ yt: this.yt, predictor: this.predictor });

    this.videoApi = new VideoProcessorApiClient({ baseUrl: args.env.VIDEO_PROCESSOR_API_BASE_URL });

    this.uploader = new YouTubeUploader({
      clientId: this.env.YOUTUBE_OAUTH_CLIENT_ID,
      clientSecret: this.env.YOUTUBE_OAUTH_CLIENT_SECRET,
      redirectUri: this.env.YOUTUBE_OAUTH_REDIRECT_URI,
      // 국가별 토큰 매핑
      tokens: {
        KR: this.env.YOUTUBE_OAUTH_REFRESH_TOKEN_KR,
        US: this.env.YOUTUBE_OAUTH_REFRESH_TOKEN_US,
        MX: this.env.YOUTUBE_OAUTH_REFRESH_TOKEN_MX
      }
    });
  }

  /**
   * [메서드 책임] 상태 로드
   * @param {string} runId
   * loadOrCreate: RunStateStore.js에서 정의
   */
  load(runId) {
    return this.store.loadOrCreate(runId);
  }

  /**
   * [메서드 책임] 상태 저장
   * @param {object} state
   */
  save(state) {
    this.store.save(state);
  }

  /**
   * [메서드 책임] region 단위 트렌드 키워드 확보(API)
   * @param {string} region
   * @param {string} runId
   * @retrun {void}, state.regions[region]에 keword 배열 저장
   */
  async runRegionKeword(region, runId) {
    // log.info("트렌드 수집 로직 진입")

    let state = this.load(runId);
    const rs = state.regions[region];
    if (isDone(rs.status)) return; /// 

    rs.status = "RUNNING";
    rs.trends = rs.trends || { status: "PENDING" }; //기본값 할당(Default Assignment) 왼쪽 항목 우선 할당
    this.save(state);

    // 키워드 수집 여부 확인
    if (!isDone(rs.trends.status)) {
      log.info(`📈${region} 지역 Trend 수집 시작`)
      rs.trends.status = "RUNNING";
      this.save(state);

      try {
        const keywords = await withRetry(
          async () => {
            const data = await this.trendApi.getDailyTrends({ region, days: 7 });

            // [방어 로직] 키워드가 2개 미만이면 에러를 던져서 retry하게 만듦
            if (!data || data.length < 2) {
              throw new Error(`📈${region}지역 키워드 부족 (검색된 개수: ${data?.length || 0})`);
            }
            return data;
          },
          `trend:${region}`
        );

        // 검증 통과 시에만 DONE 처리
        rs.trends.status = "DONE";
        rs.trends.keywords = keywords;
        rs.trends.updatedAt = new Date().toISOString();
        this.save(state);

        log.info({ region, keywords: keywords.length }, `📈${region}지역 트렌드 키워드 수집 완료`);

      } catch (err) {
        // 최종 실패 시 상태 처리
        rs.trends.status = "ERROR";
        rs.trends.lastError = err.message;
        this.save(state);

        log.error({ region, error: err.message }, `📈${region}지역 트렌드 키워드 수집 최종 실패 (2개 미만 혹은 서버 오류)`);
      }
    } else {
      const existingCount = rs.trends.keywords?.length || 0;
      log.info(
        { region, keywordCount: existingCount }, `⏩ ${region} Trend가 이미 수집되어 있어 스킵합니다. (기존 키워드: ${existingCount}개)`
      );
    }
  }

  /**
   * [메서드 책임]
   * - region+slot 처리:
   *   1) 키워드/소스영상(Top4) 선정
   *   2) 허가된 소스(mp4) 매핑(SourceResolver)
   *   3) Video Processor API 호출(편집 + LLM 메타)
   *   4) YouTube 업로드(옵션)
   *
   * @param {string} region
   * @param {string} runId
   * @param {1|2} slot
   */
  async runVideoSlot(region, runId, slot) {
    const slotID = `${runId}_${region}_${slot}`;
    log.info({ region, slot, slotID }, `${slotID} runVideoSlot 진입`);

    // ====== 단계 0: 상태 로드 및 Job 추출 ===================
    let state = this.load(runId);
    const rs = state.regions?.[region];

    if (!rs) {
      console.error(`❌ [${slotID}] 리전 데이터(${region})를 찾을 수 없습니다.`);
      return;
    }

    rs.assignedKeywords = rs.assignedKeywords || [];
    const job = rs.videos.find((v) => v.slot === slot);
    if (!job) {
      console.error(`❌ [${slotID}] slot(${slot})에 해당하는 job을 찾을 수 없습니다.`);
      return;
    }

    // 이미 최종 완료면 종료
    if (isDone(job.status)) {
      log.info({ slotID }, `👌 [${slotID}] 이미 제작-업로드 완료(DONE) 상태입니다. 종료합니다.`);
      return;
    }

    // 작업 디렉토리는 "재시도/재실행"에서도 동일해야 하므로 초반에 고정 생성
    const workDir = path.join(
      this.paths.workDir,
      runId,
      `${region}_video_${String(slot).padStart(2, "0")}`
    );
    ensureDir(workDir);

    // ===== 단계 A: 키워드 선정 & 소스 비디오 매칭 =====
    // 재시도 조건: job.keyword 있고 selectedSourceVideos 4개면 pick 단계 스킵
    const hasPickedKeywordAndSources = // ‘키워드’와 ‘소스 영상 4개’ 여부 판단
      !!job.keyword &&
      Array.isArray(job.selectedSourceVideos) &&
      job.selectedSourceVideos.length === 4;

    /** picked는 이후 단계에서 공통으로 쓰기 위해 형태를 맞춰 둠 */
    let picked = null;

    if (hasPickedKeywordAndSources) {
      log.info(
        { slotID, keyword: job.keyword },
        `⏭️ [${slotID}] 키워드/소스(4개)가 이미 존재합니다.`
      );

      picked = { keyword: job.keyword, videos: job.selectedSourceVideos };

      // 재실행 시 sourceMeta.json이 없을 수도 있으니(중간에 죽은 경우) 여기서도 한번 써주면 안전함
      writeJsonAtomic(path.join(workDir, "sourceMeta.json"), {
        runId,
        date: runId,
        region,
        slot,
        keyword: picked.keyword,
        selected: job.selectedSourceVideos
      });
    } else {
      // 트렌드 키워드 존재 여부 확인 (pick이 필요할 때만 검사)
      const keywords = rs.trends?.keywords || [];
      const totalKeywords = keywords.length;

      if (!keywords.length) {
        const errorMsg = `[${region}] 트렌드 키워드가 비어 있습니다 (status: ${rs.trends?.status})`;
        job.status = "ERROR";
        job.error = errorMsg;
        this.save(state);

        console.error(`🚨 비디오 생성 실패: ${slotID}`);
        console.error(`📝 원인: ${errorMsg}`);
        return;
      }

      const excludeList = rs.assignedKeywords.filter(k => k !== job.originalKeyword); // 이번 슬롯에서 제외할 키워드 목록 (다른 슬롯에 이미 할당된 키워드 + 이번 슬롯의 기존 원본 키워드)

      // 실행 상태 마킹
      job.status = "RUNNING";
      this.save(state);

      if (job.queryEngineering?.status === "DONE" && job.keyword && job.selectedSourceVideos?.length > 0) {
        log.info(`[${slotID}] 이미 쿼리 엔지니어링이 완료된 슬롯입니다. (Keyword: ${job.keyword}) 단계를 스킵합니다.`);
        // 바로 비디오 제작 단계로 진입하기 위해 picked 설정
        picked = {
          keyword: job.keyword,
          videos: job.selectedSourceVideos,
          originalKeyword: job.originalKeyword
        };
      } else {

        // [외곽 루프] 트렌드 키워드 순회
        for (const rawKeyword of keywords) {
          if (excludeList.includes(rawKeyword)) continue;

          log.info(`[${slotID}] 트렌드 '${rawKeyword}'에 대한 영상 클러스터링(VC) 및 검증 시작`);

          try {
            // 1. 서버 호출하여 검색 -> 군집화(형식+주제)된 클러스터 수신
            const vcResult = await this.trendApi.refineTrendKeywordVC(rawKeyword, region);
            const { clusters, analysis } = vcResult;

            log.info(
              `[${slotID}] 🔍 검색 결과 요약: 총 ${analysis.totalSearched}개 발견 -> 쇼츠(80s) ${analysis.totalShorts}개 분류 완료`
            );

            const clusterLogs = [];
            // 2. 군집별로 순회하며 pred7 예측 및 검증
            for (const cluster of clusters) {
              log.info(`[${slotID}] 군집 검증 시도: [${cluster.name}] ${cluster.query} (영상 ${cluster.videos.length}개)`);

              // 재검색 없이 군집 내부 영상을 그대로 Validation // 임시 공사 시작 구간 🛠️🛠️🛠️🛠️🛠️🛠️🛠️
              // const vResult = await this.validator.validateCluster({  
              //   clusterVideos: cluster.videos,
              //   region
              // });

              // 로깅용: 각 군집별 pred7 기준 상위 6개 비디오 추출
              // const top6Videos = (vResult.scored || []).slice(0, 6).map(v => ({
              //   videoId: v.videoId,
              //   title: v.title,
              //   predicted7d: v.predicted7d 
              // }));  // 임시 공사 끝 구간 🛠️🛠️🛠️🛠️🛠️🛠️🛠️

              // 임시 사용 시작 구간 🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈
              const vResult = await this.validator.validateCluster4ViewCount({ // 교체된 호출
                clusterVideos: cluster.videos,
                region,
                slot
              });

              // 1. 로깅 데이터 생성: 예측 API OFF 상태이므로 viewCount를 predicted7d로 매핑하여 기록
              const top6Videos = (vResult.scored || []).slice(0, 6).map(v => ({
                videoId: v.videoId,
                title: v.title,
                predicted7d: v.viewCount // 실제 조회수를 기록하여 리포트 가시성 확보
              }));
              // 임시 사용 끝 구간 🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈🎈

              // 로깅 데이터 적재
              clusterLogs.push({
                name: cluster.name,
                description: cluster.description,
                query: cluster.query,
                status: vResult.ok ? "PASS" : "FAIL",
                reason: vResult.reason,
                topVideos: top6Videos
              });

              // 2. 최초 통과 군집이 나오면 'picked' 객체 생성 (루프는 계속 돌며 로그 수집 가능하나, 리소스 위해 break 추천)
              if (vResult.ok && !picked) {
                // 3개면 3개, 4개면 4개 있는 그대로를 사용 (동적 대응)
                const selectedVideos = vResult.videos.slice(0, 4);

                picked = {
                  keyword: cluster.query,
                  videos: selectedVideos,
                  originalKeyword: rawKeyword,
                  theme: cluster.name
                };
                log.info(`[${slotID}] ✅ 주제 확정: ${picked.theme} (영상 ${selectedVideos.length}개)`);

                log.info(`[${slotID}] ✅ 주제 확정: ${picked.theme} (영상 ${selectedVideos.length}개)`);

                // 모든 군집의 예측 결과를 로깅하려면 여기서 break 하지 않고 플래그만 세움
                break;
              } else {
                log.warn(`[${slotID}] ⛔ 군집 결격: ${vResult.reason}`);
              }
            }

            // 3. [핵심] 최종 상태 업데이트 (루프 종료 후 딱 한 번만 수행)
            job.queryEngineering = {
              status: picked ? "DONE" : "FAILED", // 선정 완료 여부
              stats: {
                totalSearched: analysis.totalSearched,
                totalShorts: analysis.totalShorts
              },
              vcClusters: clusterLogs // 모든 군집 시도 이력 통합
            };

            if (picked) {
              // 성공 시 최종 데이터 바인딩
              job.originalKeyword = picked.originalKeyword;
              job.keyword = picked.keyword;
              job.videos = picked.videos;
              job.theme = picked.theme;

              if (!rs.assignedKeywords.includes(rawKeyword)) rs.assignedKeywords.push(rawKeyword);
              this.save(state);
              break; // 다른 트렌드 키워드 시도 중단 (슬롯 채움)
            } else {
              // 실패 시에도 키워드 소비 처리
              if (!rs.assignedKeywords.includes(rawKeyword)) rs.assignedKeywords.push(rawKeyword);
              this.save(state);
              log.warn(`[${slotID}] '${rawKeyword}'의 모든 군집이 탈락하였습니다.`);
            }

          } catch (err) {
            log.error({ err: err.message }, `[${slotID}] '${rawKeyword}' 처리 중 런타임 오류 발생`);
            if (!rs.assignedKeywords.includes(rawKeyword)) rs.assignedKeywords.push(rawKeyword);
            this.save(state);
          }
        }
      }
      
      if (!picked) {
        log.error(`[${slotID}] ⚠️ ${region} 국가의 모든 Trend keyword(${totalKeywords}개)가 소진되었거나 검증에 실패했습니다.`);
        log.info(`[${slotID}] 현재 슬롯 작업을 건너뛰고 다음 프로세스로 이동합니다.`);
        return null;
      }

      // 4) 상태 객체(runId.json)에 상세 정보 기록
      job.keyword = picked.keyword;                // 최종 채택된 구체화 쿼리 (예: '2026 동계올림픽 차준환|이채운')

      // selectedSourceVideos는 뒤쪽 VideoProcessor에서 핵심 재료로 쓰임
      job.selectedSourceVideos = picked.videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        channelTitle: v.channelTitle,
        predicted7d: v.predicted7d,
        delta: v.delta
      }));

      // 어떤 테마가 뽑혔는지 기록 (분석용)
      const selectedSlot = job.queryEngineering?.slots?.find(s => s.q === picked.keyword);
      job.selectedTheme = selectedSlot ? selectedSlot.theme : "Unknown";

      job.status = "RUNNING";
      this.save(state); // runId.json 저장

      // 5) 작업 디렉토리의 sourceMeta.json 기록 (Video Processor 참조용)
      // 원본 키워드와 구체화된 쿼리를 모두 넘겨주어 편집 시 LLM이 맥락을 파악하게 함
      writeJsonAtomic(path.join(workDir, "sourceMeta.json"), {
        runId,
        date: runId,
        region,
        slot,
        originalKeyword: job.originalKeyword,
        refinedKeyword: job.keyword,
        theme: job.selectedTheme,
        selected: job.selectedSourceVideos
      });

      log.info(`[${slotID}] 최종 쿼리 확정: '${job.keyword}' (테마: ${job.selectedTheme})`);
    } // <-- 여기까지가 "단계 A"의 닫는 괄호입니다.


    // ======== 단계 B: Video Processor =========
    // DONE이면 스킵, 아니면 수행
    // (가능하면 outputFileAbs도 job에 저장해두는게 재시도에 매우 유리)
    const vpAlreadyDone = job.videoProcessor?.status === "DONE" && !!job.outputFile;

    // outputFileAbs 방어적으로 구성
    const inferredOutputAbs = path.join(workDir, job.outputFile || "final.mp4");
    const outputFileAbs = job.outputFileAbs || inferredOutputAbs;

    if (vpAlreadyDone) {// 파일이 실제로 없으면(디스크 정리/실패) 다시 생성하도록 방어
      const exists = typeof fs?.existsSync === "function" ? fs.existsSync(outputFileAbs) : true;

      if (exists) {
        log.info(
          { slotID, outputFile: job.outputFile },
          `⏭️ [${slotID}] videoProcessor 이미 DONE 입니다. videoApi.process() 스킵`
        );
      } else {
        log.info(
          { slotID, outputFileAbs },
          `⚠️ [${slotID}] videoProcessor는 DONE인데 파일이 없습니다. 재생성 진행`
        );
        job.videoProcessor = { status: "RUNNING" };
        this.save(state);

        const vpRes = await withRetry(
          async () => this.videoApi.process({
            workDir,
            topic: picked.keyword,
            slotID,
            HIGHLIGHT_SECOND,
            region,
            sources: picked.selectedSourceVideos // 👈 이 부분을 반드시 추가해야 합니다!
          }),
          `videoApi:${region}:slot${slot}`
        );

        if (!vpRes.ok) {
          job.videoProcessor = { status: "ERROR", error: vpRes.error || "Video Processor 실패" };
          job.status = "ERROR";
          job.error = vpRes.error || "Video Processor 실패";
          this.save(state);
          log.error({ error: vpRes.error }, `❌ [${slotID}] Video Processor 실패`);
          return;
        }

        job.videoProcessor = { status: "DONE" };
        job.outputFile = vpRes.outputFile || "final.mp4";
        job.outputFileAbs = vpRes.outputFileAbs || path.join(workDir, job.outputFile);
        job.uploadMeta = vpRes.uploadMeta || null; // 업로드 메타 재사용(선택)
        this.save(state);
      }
    } else {
      job.videoProcessor = { status: "RUNNING" };
      this.save(state);

      log.info({ slotID, keyword: picked.keyword }, `🎬 [${slotID}] 비디오 생성 시작`);
      const vpRes = await withRetry(
        async () => this.videoApi.process({
          workDir,
          topic: picked.keyword,
          slotID,
          HIGHLIGHT_SECOND,
          region,
          // [수정] 수집된 소스 영상 데이터를 명시적으로 전달
          sources: job.selectedSourceVideos
        }),
        `videoApi:${region}:slot${slot}`
      );

      if (!vpRes || !vpRes.ok) {
        const errorMsg = vpRes?.error || "Video Processor 연결 실패 또는 알 수 없는 오류";

        job.videoProcessor = {
          status: "ERROR",
          error: errorMsg
        };
        job.status = "ERROR";
        job.error = errorMsg;

        this.save(state);

        // 로그에 에러 객체를 함께 찍어주면 추적이 더 쉽습니다.
        log.error({ slotID, error: errorMsg }, `❌ Video Processor 실패`);
        return;
      }

      job.videoProcessor = { status: "DONE" };
      job.outputFile = vpRes.outputFile || "final.mp4";
      job.outputFileAbs = vpRes.outputFileAbs || path.join(workDir, job.outputFile);
      job.uploadMeta = vpRes.uploadMeta || null; // 업로드 메타 재사용용(선택)
      this.save(state);
    }

    // ===== 단계 C: Upload =====
    // 업로더 disabled면 SKIPPED
    if (!this.uploader.isEnabled(region)) {
      if (job.upload?.status !== "SKIPPED") {
        log.info({ slotID, region }, `⏭️ [${slotID}] ${region} uploader 설정 없음. upload SKIPPED`);
        job.upload = { status: "SKIPPED" };
        this.save(state);
      }
    } else {
      if (job.upload?.status === "DONE") {
        log.info(
          { slotID, youtubeVideoId: job.upload.youtubeVideoId },
          `⏭️ [${slotID}] upload 이미 DONE 입니다. upload() 스킵`
        );
      } else {
        job.upload = { status: "RUNNING" };
        this.save(state);
        log.info(
          { slotID, topic: picked.keyword },
          `⏭️ [${slotID}] Youtube 업로드 시도 진입합니다.`
        );
        const filePath = job.outputFileAbs || path.join(workDir, job.outputFile || "final.mp4");

        // vpRes가 없을 수도 있으니(job.uploadMeta로 백업), 그래도 없으면 기본값
        const title =
          job.uploadMeta?.title || `[${region}] ${picked.keyword}`;

        const tagString = (job.uploadMeta?.tags || [])
          .map(tag => `#${tag.trim()}`)
          .join(' ');

        // 2. 최종 설명란 조립 (줄바꿈 \n 포함)
        const description = [
          job.uploadMeta?.description || "No description provided.", // 기존 설명글
          "\n",
          tagString, // 가공된 해시태그들
        ].join('\n');

        const tags = job.uploadMeta?.tags || [];

        log.info({ slotID, region, filePath }, `📤 [${slotID}] ${region} 채널 업로드 시작`);

        // 변경점: retry 시 region 정보를 넘깁니다.
        const up = await withRetry(
          async () => this.uploader.upload({
            region, // ★ 현재 슬롯의 국가 코드 주입
            title,
            description,
            tags,
            filePath
          }),
          `upload:${region}:slot${slot}`
        );

        if (!up.ok) {
          job.upload = { status: "ERROR", error: up.error || "업로드 실패" };
          job.status = "ERROR";
          job.error = up.error || "업로드 실패";
          this.save(state);
          log.error({ error: up.error }, `❌ [${slotID}] 업로드 실패`);
          return;
        }

        job.upload = { status: "DONE", youtubeVideoId: up.youtubeVideoId };
        this.save(state);
      }
    }

    // ===== 마무리: 단위 작업 완료 처리 =====
    // videoProcessor DONE + (upload DONE or SKIPPED) 이면 job DONE 처리
    const uploadOk =
      job.upload?.status === "DONE" || job.upload?.status === "SKIPPED";
    const vpOk = job.videoProcessor?.status === "DONE";

    if (vpOk && uploadOk) {
      job.status = "DONE";
      job.updatedAt = new Date().toISOString();
      this.save(state);

      // 상위 공정(Region) 완료 여부 판단
      const regionDone = rs.videos.every((v) => isDone(v.status));
      rs.status = regionDone ? "DONE" : "RUNNING";
      rs.updatedAt = new Date().toISOString();
      this.save(state);

      log.info({ slotID }, `✅ [${slotID}] 슬롯 작업 완료`);
    } else {
      // 이 케이스는 이론상 거의 없어야 정상.
      log.warn(
        { slotID, vpStatus: job.videoProcessor?.status, upStatus: job.upload?.status },
        `⚠️ [${slotID}] 마무리 조건 불충족. 상태 점검 필요`
      );
    }
  }


  /**
   * [메서드 책임] run 종료 처리
   * @param {string} runId
   * @param {string[]} regions
   */
  finishRun(runId, regions) {
    const state = this.load(runId);
    const allDone = regions.every((r) => state.regions[r].videos.every((v) => isDone(v.status)));
    state.status = allDone ? "DONE" : "ERROR";
    state.finishedAt = new Date().toISOString();
    this.save(state);
  }

  /**
   * [메서드 책임] 수동 실행(Sub-Orchestrator)
   * - 트렌드 없이 “region + keyword + date”를 키로 1개의 영상만 생성합니다.
   * @param {{region:string, keyword:string, date:string}} args
   */
  async runManualOne(args) {
    const runId = `${args.date}__MANUAL__${args.region}__${slugify(args.keyword)}`;

    // 수동 run은 상태 파일 구조를 단순하게 쓰기 위해: region 1개만 사용
    let state = this.load(runId);

    const rs = state.regions[args.region];
    if (rs) {
      rs.status = "PENDING";
      rs.assignedKeywords = rs.assignedKeywords || []; // 기존 값 유지 혹은 초기화
      rs.trends = {
        status: "SKIPPED",
        keywords: [args.keyword]
      };
      // 수동 실행은 보통 슬롯 1개만 타겟팅하므로 필터링
      rs.videos = [{ slot: 1, status: "PENDING" }];
    }
    // 3. 변경 사항 즉시 저장
    this.save(state);
    log.info({ runId, keyword: args.keyword }, "수동 실행 상태 초기화 완료");

    // 4. 비디오 생성 시작
    await this.runVideoSlot(args.region, runId, 1);
    this.finishRun(runId, [args.region]);

    log.info({ runId, keyword: args.keyword }, "영상 제작 완료");

    return runId;
  }
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
