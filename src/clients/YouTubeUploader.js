/**
 * [파일 책임]
 * - OAuth2 Refresh Token 기반 YouTube 업로드를 수행합니다.
 */

import fs from "node:fs";
import { google } from "googleapis";
import { createLogger } from "../utils/logger.js";

const log = createLogger("YouTubeUploader");

// src/clients/YouTubeUploader.js

export class YouTubeUploader {
  constructor(args) {
    const { clientId, clientSecret, redirectUri, tokens } = args;
    this.clients = {};

    // 3개 국가 토큰 매핑 (KR, US, MX)
    if (tokens) {
      for (const [region, refreshToken] of Object.entries(tokens)) {
        if (!refreshToken) continue;
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        this.clients[region] = oauth2Client;
      }
    }
  }

  // 특정 지역의 업로더가 활성화되어 있는지 확인
  isEnabled(region) {
    return !!this.clients[region];
  }

  async upload(args) {
    const { region, title, description, tags, filePath } = args;
    const auth = this.clients[region];

    if (!auth) return { ok: false, error: `${region} 업로더 비활성` };
    if (!fs.existsSync(filePath)) return { ok: false, error: `파일 없음: ${filePath}` };

    try {
      const youtube = google.youtube({ version: "v3", auth });
      const res = await youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title, description, tags },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
        },
        media: { body: fs.createReadStream(filePath) }
      });

      return { ok: true, youtubeVideoId: res.data.id };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
