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
      clientId: process.env.YOUTUBE_OAUTH_CLIENT_ID,
      clientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI,
      refreshToken: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN
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

    // 1) 상태 로드 및 Job 추출
    let state = this.load(runId);
    const rs = state.regions?.[region];

    if (!rs) {
      console.error(`❌ [${slotID}] 리전 데이터(${region})를 찾을 수 없습니다.`);
      return;
    }

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
        `⏭️ [${slotID}] 키워드/소스(4개)가 이미 존재합니다. pickKeywordAndTopVideos() 스킵`
      );

      picked = { keyword: job.keyword, videos: job.selectedSourceVideos };

      // 재실행 시 meta.json이 없을 수도 있으니(중간에 죽은 경우) 여기서도 한번 써주면 안전함
      writeJsonAtomic(path.join(workDir, "meta.json"), {
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
      if (!keywords.length) {
        const errorMsg = `[${region}] 트렌드 키워드가 비어 있습니다 (status: ${rs.trends?.status})`;
        job.status = "ERROR";
        job.error = errorMsg;
        this.save(state);

        console.error(`🚨 비디오 생성 실패: ${slotID}`);
        console.error(`📝 원인: ${errorMsg}`);
        return;
      }

      // "점유중 키워드" 계산: 재시도 관점에서 현재 slot의 키워드는 제외하는 게 안전함
      // (현재 job이 ERROR 상태로 재실행되는데 assignedKeywords에 본인 키워드가 남아있으면 영구 점유처럼 동작 가능)
      const assignedKeywords = rs.videos
        .filter((v) => v.slot !== slot) // ✅ 현재 slot 제외
        .map((v) => v.keyword)
        .filter((k) => k != null);

      // 실행 상태 마킹
      job.status = "RUNNING";
      this.save(state);

      // const publishedAfterISO = new Date(Date.now() - VALIDATION.recentDays * 24 * 3600 * 1000).toISOString();

      // [외곽 루프] 트렌드 키워드 순회
      for (const rawKeyword of keywords) {
        if (assignedKeywords.includes(rawKeyword)) continue;

        log.info(`[${slotID}] 트렌드 '${rawKeyword}'에 대한 QE 및 검증 시작`);

        try {
          // 1. 태그 수집
          const searchForTags = await this.yt.searchVideos({ q: rawKeyword, maxResults: 50, region });
          const tags = await this.yt.collectHashtags(searchForTags.map(v => v.videoId));

          // 2. 서버(QE API) 호출하여 구체화된 쿼리 후보 3개 획득
          const { slots, analysis } = await this.trendApi.refineTrendKeyword(rawKeyword, tags);

          // 분석 로그 저장 (디버깅용)
          job.queryEngineering = analysis;
          this.save(state);

          // [내부 루프] 3개의 구체화 쿼리 후보 순회 검증
          for (const slotCandidate of slots) {
            log.info(`[${slotID}] 후보 검증 시도: ${slotCandidate.q} (${slotCandidate.theme})`);

            const result = await this.validator.validateSingleQuery({
              q: slotCandidate.q,
              region,
              slot
            });

            if (result) {
              picked = { keyword: slotCandidate.q, videos: result.videos };
              break; // 내부 루프 탈출
            }
          }

          if (picked) break; // 적합한 쿼리 찾았으므로 외곽 루프 탈출
        } catch (err) {
          log.error({ err }, `[${slotID}] '${rawKeyword}' 처리 중 오류 발생, 다음 키워드로 이동`);
        }
      }

      if (!picked) {
        throw new Error("모든 트렌드 키워드와 쿼리 후보군이 조건을 만족하지 못했습니다.");
      }
      // ======================================================================

      // 1) 상태 객체(runId.json)에 상세 정보 기록
      job.originalKeyword = picked.originalKeyword; // 처음에 제시된 원본 트렌드 (예: '2026 동계올림픽')
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

      // 2) 작업 디렉토리의 meta.json 기록 (Video Processor 참조용)
      // 원본 키워드와 구체화된 쿼리를 모두 넘겨주어 편집 시 LLM이 맥락을 파악하게 함
      writeJsonAtomic(path.join(workDir, "meta.json"), {
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

    
    // ===== 단계 B: Video Processor =====
    // DONE이면 스킵, 아니면 수행
    // (가능하면 outputFileAbs도 job에 저장해두는게 재시도에 매우 유리)
    const vpAlreadyDone = job.videoProcessor?.status === "DONE" && !!job.outputFile;

    // outputFileAbs 방어적으로 구성
    const inferredOutputAbs = path.join(workDir, job.outputFile || "final.mp4");
    const outputFileAbs = job.outputFileAbs || inferredOutputAbs;

    if (vpAlreadyDone) {
      // 파일이 실제로 없으면(디스크 정리/실패) 다시 생성하도록 방어
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
          async () => this.videoApi.process({ workDir, topic: picked.keyword, slotID, HIGHLIGHT_SECOND }),
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
        job.uploadMeta = vpRes.uploadMeta || null; // 업로드 메타 재사용용(선택)
        this.save(state);
      }
    } else {
      job.videoProcessor = { status: "RUNNING" };
      this.save(state);

      log.info({ slotID, keyword: picked.keyword }, `🎬 [${slotID}] 비디오 생성 시작`);
      const vpRes = await withRetry(
        async () => this.videoApi.process({ workDir, topic: picked.keyword, slotID, HIGHLIGHT_SECOND }),
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
      job.uploadMeta = vpRes.uploadMeta || null; // 업로드 메타 재사용용(선택)
      this.save(state);
    }

    // ===== 단계 C: Upload =====
    // 업로더 disabled면 SKIPPED
    if (!this.uploader.isEnabled()) {
      if (job.upload?.status !== "SKIPPED") {
        log.info({ slotID }, `⏭️ [${slotID}] uploader 비활성화. upload SKIPPED 처리`);
        job.upload = { status: "SKIPPED" };
        this.save(state);
      }
    } else {
      // enabled인 경우: 이미 DONE이면 스킵
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
        const description =
          job.uploadMeta?.description || "";
        const tags =
          job.uploadMeta?.tags || [];

        log.info({ slotID, filePath }, `📤 [${slotID}] 업로드 시작`);
        const up = await withRetry(
          async () => this.uploader.upload({ title, description, tags, filePath }),
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

    // 1. regions 객체가 없으면 생성
    if (!state.regions) state.regions = {};

    // 2. 해당 리전 데이터를 강제로 셋팅 (이미 있어도 덮어씀)
    state.regions[args.region] = {
      region: args.region,
      // 수동 실행이므로 trends를 SKIPPED로 하고 키워드를 직접 주입
      trends: {
        status: "SKIPPED",
        keywords: [args.keyword]
      },
      videos: state.regions[args.region]?.videos || [{ slot: 1, status: "PENDING" }],
      status: "PENDING"
    };

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
