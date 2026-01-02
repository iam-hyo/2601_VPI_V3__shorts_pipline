/**
 * [파일 책임]
 * - YouTube Data API v3를 통해 검색/메타/통계를 조회합니다.
 * - predictor request body를 만들기 위한 특징치(Feature)를 구성합니다.
 *
 * [주의]
 * - API 호출량이 늘어날 수 있으니 quota 모듈 추가를 권장합니다.
 */

import { google } from "googleapis";
import { createLogger } from "../utils/logger.js";

const log = createLogger("YouTubeClient");

export class YouTubeClient {
  /**
   * [생성자 책임] googleapis client 생성
   * @param {{apiKey:string}} args
   */
  constructor(args) {
    if (!args.apiKey) log.warn("YOUTUBE_API_KEY가 비어 있습니다(검색/메타 불가).");
    this.youtube = google.youtube({ version: "v3", auth: args.apiKey });
  }

  /**
   * [메서드 책임] 키워드로 최신 영상 검색(최대 50개)
   * @param {{q:string, maxResults?:number, publishedAfterISO?:string}} args
   * @returns {Promise<Array<{videoId:string,title:string,channelTitle:string,publishedAt:string}>>}
   */
  async searchVideos(args) {
    const res = await this.youtube.search.list({
      part: ["snippet"],
      q: args.q,
      type: ["video"],
      maxResults: args.maxResults ?? 50,
      order: "date",
      publishedAfter: args.publishedAfterISO
    });

    const items = res.data.items ?? [];
    return items
      .map((it) => {
        const videoId = it.id?.videoId;
        const sn = it.snippet;
        if (!videoId || !sn?.title || !sn?.channelTitle || !sn?.publishedAt) return null;
        return { videoId, title: sn.title, channelTitle: sn.channelTitle, publishedAt: sn.publishedAt };
      })
      .filter(Boolean);
  }

  /**
   * [메서드 책임] predictor 요청 스키마에 맞는 features 구성
   * @param {{videoIds:string[], region:string}} args
   * @returns {Promise<Array<object>>} VideoFeatureForPredictor[]
   */
  async buildVideoFeatures(args) {
    if (!args.videoIds?.length) return [];

    const videoRes = await this.youtube.videos.list({
      part: ["snippet", "contentDetails", "statistics"],
      id: args.videoIds
    });

    const items = videoRes.data.items ?? [];
    const channelIds = Array.from(new Set(items.map((it) => it.snippet?.channelId).filter(Boolean)));

    const channelSubs = await this.getChannelSubscriberCounts(channelIds);
    const categoryTitles = await this.getCategoryTitles(args.region);

    const out = [];
    for (const it of items) {
      const id = it.id;
      const sn = it.snippet;
      const st = it.statistics;
      const cd = it.contentDetails;
      if (!id || !sn || !st || !cd) continue;

      const viewCount = Number(st.viewCount ?? 0);
      const likeCount = Number(st.likeCount ?? 0);
      const commentCount = Number(st.commentCount ?? 0);

      const durationSec = parseIsoDurationToSec(cd.duration ?? "PT0S");
      const isShort = Number.isFinite(durationSec) ? durationSec <= 60 : false;

      const categoryId = Number(sn.categoryId ?? 0);
      const categoryGroup = categoryTitles.get(String(categoryId)) ?? "Unknown";

      const subs = channelSubs.get(sn.channelId ?? "") ?? 0;

      out.push({
        id,
        subscriber_count: subs,
        upload_date: sn.publishedAt ?? new Date().toISOString(),
        video_length: Number.isFinite(durationSec) ? durationSec : 0,
        view_count: viewCount,
        like_count: likeCount,
        comment_count: commentCount,
        category_id: categoryId,
        is_short: isShort,
        category_group: categoryGroup,

        // 디버깅/추적용
        title: sn.title ?? "",
        channel_title: sn.channelTitle ?? ""
      });
    }
    return out;
  }

  /**
   * [메서드 책임] 채널 subscriber_count 조회
   * @param {string[]} channelIds
   * @returns {Promise<Map<string,number>>}
   */
  async getChannelSubscriberCounts(channelIds) {
    const map = new Map();
    if (!channelIds.length) return map;

    for (const ids of chunk(channelIds, 50)) {
      const res = await this.youtube.channels.list({
        part: ["statistics"],
        id: ids
      });

      for (const it of res.data.items ?? []) {
        if (!it.id) continue;
        const subs = Number(it.statistics?.subscriberCount ?? 0);
        map.set(it.id, subs);
      }
    }
    return map;
  }

  /**
   * [메서드 책임] category_id -> title 매핑
   * @param {string} region KR/US/MX
   * @returns {Promise<Map<string,string>>}
   */
  async getCategoryTitles(region) {
    const map = new Map();
    const regionCode = region === "KR" ? "KR" : region === "MX" ? "MX" : "US";

    const res = await this.youtube.videoCategories.list({
      part: ["snippet"],
      regionCode
    });

    for (const it of res.data.items ?? []) {
      if (!it.id) continue;
      map.set(it.id, it.snippet?.title ?? "Unknown");
    }
    return map;
  }
}

function parseIsoDurationToSec(iso) {
  const m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return NaN;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3600 + min * 60 + s;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
