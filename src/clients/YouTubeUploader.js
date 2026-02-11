/**
 * src/clients/YouTubeUploader.js
 * [파일 책임]
 * - OAuth2 Refresh Token 기반 YouTube 업로드를 수행합니다.
 */

import fs from "node:fs";
import { google } from "googleapis";
import { createLogger } from "../utils/logger.js";

const log = createLogger("YouTubeUploader");

export class YouTubeUploader {
  /**
   * [생성자 책임] OAuth2 client 구성(ENV 미설정 시 비활성)
   * @param {{clientId?:string, clientSecret?:string, redirectUri?:string, refreshToken?:string}} args
   */
  constructor(args) {
    const ok = Boolean(args.clientId && args.clientSecret && args.redirectUri && args.refreshToken);
    this.enabled = ok;

    if (!ok) {
      log.warn("YouTube 업로드 설정이 불완전합니다. 업로드는 SKIP 됩니다.");
      return;
    }

    const oauth2Client = new google.auth.OAuth2(args.clientId, args.clientSecret, args.redirectUri);
    oauth2Client.on('tokens', (tokens) => {
      log.info("새로운 토큰 정보를 수신했습니다.");
      if (tokens.refresh_token) {
        // 중요: 여기서 새로운 refresh_token을 설정 파일이나 DB에 업데이트해야 합니다.
        log.info("새로운 Refresh Token을 저장해야 합니다:", tokens.refresh_token);
      }
    });
    oauth2Client.setCredentials({ refresh_token: args.refreshToken });
    this.oauth2 = oauth2Client;
  }

  /**
   * [메서드 책임] 업로드 활성 여부 반환
   * @returns {boolean}
   */
  isEnabled() {
    return Boolean(this.enabled && this.oauth2);
  }

  /**
   * [메서드 책임] 파일 업로드
   * @param {{title:string, description:string, tags:string[], filePath:string}} args
   * @returns {Promise<{ok:boolean, youtubeVideoId?:string, error?:string}>}
   */
  async upload(args) {
    if (!this.isEnabled()) return { ok: false, error: "업로드 비활성" };
    if (!fs.existsSync(args.filePath)) return { ok: false, error: `파일 없음: ${args.filePath}` };

    try {
      const youtube = google.youtube({ version: "v3", auth: this.oauth2 });
      const res = await youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title: args.title, description: args.description, tags: args.tags },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false, }
        },
        media: { body: fs.createReadStream(args.filePath) }
      });

      const id = res.data.id ?? undefined;
      if (!id) return { ok: false, error: "업로드 성공했으나 videoId 없음" };
      return { ok: true, youtubeVideoId: id };
    } catch (err) {
      log.error({ err }, "업로드 실패");
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
