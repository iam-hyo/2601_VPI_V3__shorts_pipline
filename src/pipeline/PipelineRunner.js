/**
 * [ÆÄÀÏ Ã¥ÀÓ]
 * - Resume/»óÅÂ°ü¸®/Àç½Ãµµ/¼­ºñ½º È£ÃâÀ» ¸ðµÎ ´ã´çÇÕ´Ï´Ù.
 * - Orchestrator´Â ÀÌ Å¬·¡½º¸¸ È£ÃâÇÏµµ·Ï À¯ÁöÇÏ¿© °¡µ¶¼ºÀ» ±Ø´ëÈ­ÇÕ´Ï´Ù.
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
import { resolveAuthorizedSourcePath } from "../source/SourceResolver.js";

const log = createLogger("PipelineRunner");

function isDone(s) {
  return s === "DONE" || s === "SKIPPED";
}

export class PipelineRunner {
  /**
   * [»ý¼ºÀÚ Ã¥ÀÓ] ÇÊ¿äÇÑ Å¬¶óÀÌ¾ðÆ®/¼­ºñ½º¸¦ ±¸¼ºÇÕ´Ï´Ù.
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
   * [¸Þ¼­µå Ã¥ÀÓ] »óÅÂ ·Îµå
   * @param {string} runId
   * loadOrCreate: RunStateStore.js¿¡¼­ Á¤ÀÇ
   */
  load(runId) {
    return this.store.loadOrCreate(runId);
  }

  /**
   * [¸Þ¼­µå Ã¥ÀÓ] »óÅÂ ÀúÀå
   * @param {object} state
   */
  save(state) {
    this.store.save(state);
  }

  /**
   * [¸Þ¼­µå Ã¥ÀÓ] region ´ÜÀ§ Æ®·»µå Å°¿öµå È®º¸(API)
   * @param {string} region
   * @param {string} runId
   * @retrun {void}, state.regions[region]¿¡ keword ¹è¿­ ÀúÀå
   */
  async runRegionKeword(region, runId) {
    let state = this.load(runId);
    const rs = state.regions[region];
    if (isDone(rs.status)) return;

    rs.status = "RUNNING";
    rs.trends = rs.trends || { status: "PENDING" }; //±âº»°ª ÇÒ´ç(Default Assignment) ¿ÞÂÊ Ç×¸ñ ¿ì¼± ÇÒ´ç
    this.save(state);

    if (!isDone(rs.trends.status)) {
      rs.trends.status = "RUNNING";
      this.save(state);

      try {
        const keywords = await withRetry(
          async () => {
            const data = await this.trendApi.getDailyTrends({ region, days: 7 });

            // [¹æ¾î ·ÎÁ÷] Å°¿öµå°¡ 2°³ ¹Ì¸¸ÀÌ¸é ¿¡·¯¸¦ ´øÁ®¼­ retryÇÏ°Ô ¸¸µê
            if (!data || data.length < 2) {
              throw new Error(`Å°¿öµå ºÎÁ· (°Ë»öµÈ °³¼ö: ${data?.length || 0})`);
            }
            return data;
          },
          `trend:${region}`
        );

        // °ËÁõ Åë°ú ½Ã¿¡¸¸ DONE Ã³¸®
        rs.trends.status = "DONE";
        rs.trends.keywords = keywords;
        rs.trends.updatedAt = new Date().toISOString();
        this.save(state);

        log.info({ region, keywords: keywords.length }, "Æ®·»µå Å°¿öµå ¼öÁý ¿Ï·á");

      } catch (err) {
        // ÃÖÁ¾ ½ÇÆÐ ½Ã »óÅÂ Ã³¸®
        rs.trends.status = "ERROR";
        rs.trends.lastError = err.message;
        this.save(state);

        log.error({ region, error: err.message }, "Æ®·»µå Å°¿öµå ¼öÁý ÃÖÁ¾ ½ÇÆÐ (2°³ ¹Ì¸¸ È¤Àº ¼­¹ö ¿À·ù)");
      }
    }
  }

  /**
   * [¸Þ¼­µå Ã¥ÀÓ]
   * - region+slot Ã³¸®:
   *   1) Å°¿öµå/¼Ò½º¿µ»ó(Top4) ¼±Á¤
   *   2) Çã°¡µÈ ¼Ò½º(mp4) ¸ÅÇÎ(SourceResolver)
   *   3) Video Processor API È£Ãâ(ÆíÁý + LLM ¸ÞÅ¸)
   *   4) YouTube ¾÷·Îµå(¿É¼Ç)
   *
   * @param {string} region
   * @param {string} runId
   * @param {1|2} slot
   */
  async runVideoSlot(region, runId, slot) {
    // 1. ÇöÀç ÁøÇà »óÅÂ ·Îµå ¹× ´ë»ó ÀÛ¾÷(Job) ÃßÃâ
    let state = this.load(runId);
    const rs = state.regions[region];
    const job = rs.videos.find((v) => v.slot === slot);
    if (isDone(job.status)) return;

    // 2. ±âÃÊ Àç·á(Å°¿öµå) Á¸Àç ¿©ºÎ È®ÀÎ
    const keywords = rs.trends?.keywords || [];
    if (!keywords.length) {
      job.status = "ERROR";
      job.error = "Æ®·»µå Å°¿öµå°¡ ºñ¾î ÀÖ½À´Ï´Ù.";
      this.save(state);
      return;
    }

    job.status = "RUNNING";
    this.save(state);

    /** 
     * 3. ´Ü°èA: Å°¿öµå ¼±Á¤ ¹× ¼Ò½º ºñµð¿À ¸ÅÄª (Àç½Ãµµ ·ÎÁ÷ Æ÷ÇÔ)
     * @returns {Promise<{keyword:string, videos:Array<object>}>}
     */
    const picked = await withRetry(
      async () => this.validator.pickKeywordAndTopVideos({ region, keywords }),
      `validate:${region}:slot${slot}`
    );

    job.keyword = picked.keyword;
    job.selectedSourceVideos = picked.videos.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      description: v.description,
      channelTitle: v.channelTitle
    }));

    // 4. ¹°¸®Àû ÀÛ¾÷ µð·ºÅä¸® ±¸¼º (File System)
    const workDir = path.join(this.paths.workDir, runId, region, `video_${String(slot).padStart(2, "0")}`);
    ensureDir(workDir);
    // ensureDir(path.join(workDir, "inputs"));
    // ensureDir(path.join(workDir, "outputs"));
    // job.workDir = workDir;

    writeJsonAtomic(path.join(workDir, "meta.json"), {
      runId,
      date: runId,
      region,
      slot,
      keyword: picked.keyword,
      selected: job.selectedSourceVideos,
    });
    this.save(state);

    // 5. ºñµð¿À Ã³¸® ´Ü°è (Video Processor API) 
    // 1) ¿µ»ó ID¸¦ ½ÇÁ¦ ·ÎÄÃ ÆÄÀÏ °æ·Î(mp4)·Î ¸ÅÇÎ, ´Ù¿î·Îµå ¹× ÇÏÀÌ¶óÀÌÆ® ÃßÃâ °úÁ¤ ÇÊ¿ä.
    // sources: ÆÄÀÏ ÆÐ½º¸¦ ´ãÀº ¹è¿­À» ¹ÝÈ¯
    // const sources = picked.videos.map((v) => ({
    //   id: v.videoId,
    //   inputPath: resolveAuthorizedSourcePath({ assetsDir: this.paths.assetsDir, videoId: v.videoId })
    // }));

    job.videoProcessor = { status: "RUNNING" };
    this.save(state);

    // 2) merge¿äÃ»
    const vpRes = await withRetry(
      async () => this.videoApi.process({ workDir, topic: picked.keyword }),
      `videoApi:${region}:slot${slot}`
    );

    if (!vpRes.ok) {
      job.videoProcessor = { status: "ERROR", error: vpRes.error || "Video Processor ½ÇÆÐ" };
      job.status = "ERROR";
      job.error = vpRes.error || "Video Processor ½ÇÆÐ";
      this.save(state);
      return;
    }

    // 6. ¿ÜºÎ ¼ÛÃâ ´Ü°è (YouTube Upload)
    job.videoProcessor = { status: "DONE" };
    job.outputFile = vpRes.outputFile || "outputs/final.mp4";
    this.save(state);

    // 6. ¿ÜºÎ ¼ÛÃâ ´Ü°è (YouTube Upload)
    if (this.uploader.isEnabled()) {
      job.upload = { status: "RUNNING" };
      this.save(state);

      const up = await withRetry(
        async () =>
          this.uploader.upload({
            title: vpRes.uploadMeta?.title || `[${region}] ${picked.keyword}`,
            description: vpRes.uploadMeta?.description || "",
            tags: vpRes.uploadMeta?.tags || [],
            filePath: vpRes.outputFileAbs
          }),
        `upload:${region}:slot${slot}`
      );

      if (!up.ok) {
        job.upload = { status: "ERROR", error: up.error || "¾÷·Îµå ½ÇÆÐ" };
        job.status = "ERROR";
        job.error = up.error || "¾÷·Îµå ½ÇÆÐ";
        this.save(state);
        return;
      }

      job.upload = { status: "DONE", youtubeVideoId: up.youtubeVideoId };
      this.save(state);
    } else {
      job.upload = { status: "SKIPPED" };
      this.save(state);
    }

    // 7. ´ÜÀ§ ÀÛ¾÷ ¿Ï·á Ã³¸®
    job.status = "DONE";
    job.updatedAt = new Date().toISOString();
    this.save(state);

    // 8. »óÀ§ °øÁ¤(Region) ¿Ï·á ¿©ºÎ ÆÇ´Ü
    // ¸ðµç ½½·ÔÀÌ ¿Ï·á(isDone)µÇ¾ú´ÂÁö Ã¼Å©ÇÏ¿© »óÀ§ »óÅÂ ¾÷µ¥ÀÌÆ®
    const regionDone = rs.videos.every((v) => isDone(v.status));
    rs.status = regionDone ? "DONE" : "RUNNING";
    rs.updatedAt = new Date().toISOString();
    this.save(state);
  }

  /**
   * [¸Þ¼­µå Ã¥ÀÓ] run Á¾·á Ã³¸®
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
   * [¸Þ¼­µå Ã¥ÀÓ] ¼öµ¿ ½ÇÇà(Sub-Orchestrator)
   * - Æ®·»µå ¾øÀÌ ¡°region + keyword + date¡±¸¦ Å°·Î 1°³ÀÇ ¿µ»ó¸¸ »ý¼ºÇÕ´Ï´Ù.
   * @param {{region:string, keyword:string, date:string}} args
   */
  async runManualOne(args) {
    const runId = `${args.date}__MANUAL__${args.region}__${slugify(args.keyword)}`;

    // ¼öµ¿ runÀº »óÅÂ ÆÄÀÏ ±¸Á¶¸¦ ´Ü¼øÇÏ°Ô ¾²±â À§ÇØ: region 1°³¸¸ »ç¿ë
    let state = this.load(runId);

    // regionÀÌ REGIONS ¿Ü¿©µµ °¡´ÉÇÏ°Ô (manualÀº ÀÓÀÇ region Çã¿ë)
    if (!state.regions?.[args.region]) {
      state.regions[args.region] = {
        region: args.region,
        trends: { status: "SKIPPED", keywords: [args.keyword] },
        videos: [{ slot: 1, status: "PENDING" }],
        status: "PENDING"
      };
      this.save(state);
    }

    // keywords´Â ÀÔ·Â°ª ÇÏ³ª¸¸ »ç¿ë
    state.regions[args.region].trends = { status: "SKIPPED", keywords: [args.keyword] };
    this.save(state);

    await this.runVideoSlot(args.region, runId, 1);
    this.finishRun(runId, [args.region]);

    return runId;
  }
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9°¡-ÆR]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
