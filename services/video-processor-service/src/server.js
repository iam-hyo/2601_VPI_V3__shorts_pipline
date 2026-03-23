/** .\services\video-processor-service\src\server.js
 * [파일 책임] 
 * - /process 요청을 받아 "다운로드(yt-dlp) → 하이라이트 → 타이틀카드 → 병합"을 수행하고
 * 최종 파일 경로 및 업로드 메타를 반환한다.
 */
import "./env.js"; // ✅ 최상단에 먼저!
import http from "node:http";
import url from "node:url";
import path from "node:path";
import { readJsonSafe } from "./utils.js";
import * as ttsService from '../audio/tts.service.js';

import {
  ensureDir,
  downloadVideoIfNeeded,
  mergeHighlightsWithIntegratedTitles,
  downloadSubtitles,
  getSmartHighlightTimestamps,
  cutSmartHighlight
} from "../video/videoEdit.service_Demo.js";
import llm from "../llm/llm.js";
import { resolveAssetPath, writeJsonAtomic } from "./utils.js";

// const titleFontPath = resolveAssetPath("Pretendard-ExtraBold.otf");
const titleFontPath = resolveAssetPath("memomentKkukkkuk.ttf");


async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

async function resolveSelectedSources({ workDir, bodySources }) {
  if (Array.isArray(bodySources) && bodySources.length > 0 && bodySources[0]?.videoId) {
    return bodySources;
  }
  const metaPath = path.join(workDir, "sourceMeta.json");
  const meta = await readJsonSafe(metaPath);
  const selected = meta?.selected || meta?.selectedSourceVideos || [];
  return Array.isArray(selected) ? selected : [];
}

const PORT = process.env.PORT || 8787;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "POST" && parsed.pathname === "/process") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON Body" });
    }

    const { workDir, topic = "", slotID = "UNKNOWN", region, HIGHLIGHT_SECOND } = body;
    const bodySources = Array.isArray(body.sources) ? body.sources : [];

    const languageMap = { 'KR': 'Korean (한국어)', 'US': 'English (영어)', 'MX': 'Spanish (스페인어)' };
    const targetLanguage = languageMap[region] || 'English (영어)';

    console.log(`[${slotID}] 📥 /process 요청 수신 (region: ${region}, targetLanguage: ${targetLanguage}), HIGHLIGHT_SECOND: ${HIGHLIGHT_SECOND}`);

    if (!workDir) {
      return sendJson(res, 400, { ok: false, error: "workDir is required" });
    }

    try {
      // 0) 디렉토리 구성
      const inputsDir = path.join(workDir, "inputs");
      const outputsDir = path.join(workDir, "outputs");
      const audioFadeInDuration = 1.3;
      await ensureDir(inputsDir);
      await ensureDir(outputsDir);

      // 1) 소스 결정 및 다운로드
      console.log(`[${slotID}] Step 1: 비디오 소스 다운로드 및 로컬 확인 중...`);
      const selectedSources = await resolveSelectedSources({ workDir, bodySources });
      if (selectedSources.length < 3) {
        throw new Error(`사용 가능한 소스 영상이 부족합니다. (현재: ${selectedSources.length}개)`);
      }

      const inputFiles = [];
      // 🐛 버그 수정: 중복된 for 선언 제거
      for (let i = 0; i < selectedSources.length; i++) {
        const s = selectedSources[i];
        const localPath = await downloadVideoIfNeeded({ videoId: s.videoId, outDir: inputsDir });
        inputFiles.push({ ...s, inputPath: localPath });
      }
      const videoCount = inputFiles.length;

      // 2) 하이라이트 추출
      console.log(`[${slotID}] Step 2: 하이라이트 컷팅 시작 (총 ${videoCount}개)...`);
      const highlightPaths = [];
      const highlightDurations = []; // 🐛 버그 수정: 배열 초기화 누락 추가

      for (let i = 0; i < inputFiles.length; i++) {
        const source = inputFiles[i]; // 🐛 버그 수정: source 변수 정의 추가
        const outPath = path.join(outputsDir, `highlight_${i + 1}.mp4`);

        const subPath = await downloadSubtitles(source.videoId, inputsDir);
        const analysis = subPath ? await getSmartHighlightTimestamps(subPath, source.videoId) : null;

        const isInvalid = !analysis || !analysis.startTime || (analysis.duration && analysis.duration < 3);

        const startTime = isInvalid ? null : analysis.startTime;
        const endTime = isInvalid ? null : analysis.endTime;
        const duration = isInvalid ? 10 : analysis.duration;
        const reason = isInvalid ? "No subtitles or analysis failed. Fallback to last 10s." : analysis.reason;

        source.analysis = {
          startTime: startTime || "EOF-10s",
          endTime: endTime ? endTime : "EOF",
          duration: duration,
          reason: reason,
          isSmart: !isInvalid
        };

        await cutSmartHighlight({
          inputPath: source.inputPath,
          outputPath: outPath,
          startTime: startTime,
          duration: duration,
          audioFadeInDuration: audioFadeInDuration
        });

        highlightPaths.push(outPath);
        highlightDurations.push(duration);
      }

      // 2.5) sourceMeta.json 업데이트
      const metaPath = path.join(workDir, "sourceMeta.json");
      const currentMeta = await readJsonSafe(metaPath);
      if (currentMeta) {
        currentMeta.selected = inputFiles.map(f => ({
          videoId: f.videoId,
          title: f.title,
          channelTitle: f.channelTitle,
          sevenDelta: f.delta,
          analysis: f.analysis
        }));
        await writeJsonAtomic(metaPath, currentMeta);
      }

      // 3) LLM: 캡션 및 메타데이터 생성
      console.log(`[${slotID}] Step 3: LLM 메타데이터 생성 시도...`);
      const prompt = {
        topic,
        sources: inputFiles.map((v) => ({
          title: v.title,
          channelTitle: v.channelTitle,
          description: v.description,
        })),
        task: [
          `참조 영상 ${videoCount}개의 제목/설명을 바탕으로, 각 클립 시작 전 타이틀 카드에 넣을 ${targetLanguage} caption ${videoCount}개를 만들어라(각 1~6단어).`,
          `또한 최종 업로드용 ${targetLanguage} 제목(40자 이내), 설명(2~3문장), tags 배열(5~10개)을 만들어라.`,
          `캡션은 자극적이고 키치한 ${targetLanguage} 후킹 문구로 작성하며, 관련된 고유명사를 적극적으로 활용하라.(어그로 허용).`,
          "문장보다 명사구(noun phrase) 형태를 권장한다.",
          "해시태그 내부에는 절대 공백(Space)을 포함하지 말 것",
          "각 캡션은 4단어 이하를 권장한다(최대 6단어, 공백포함 20자).",
          "대주제(topic)를 그대로 반복하지 말고, 각 영상 고유의 특징을 반영하라.",
          `반드시 모든 텍스트 결과물은 ${targetLanguage}로 작성해야 한다.`,
          "잡담/설명/마크다운 없이 outputFormat에 맞는 순수 JSON만 반환하라."
        ],
        outputFormat: {
          captions: ["string", "string", "string"],
          uploadMeta: { title: "string", description: "string", tags: ["string"] }
        }
      };

      let uploadMeta;
      let captions;
      const defaultCaptions = ["WOW", "NO WAY", "INSANE", "UNREAL", "AMAZING", "LEGEND"];
      const fallbackCaptions = defaultCaptions.slice(0, inputFiles.length);

      try {
        const subTitleText = await llm.generateJson(prompt);
        // 🛡️ 방어적 프로그래밍: LLM이 마크다운(```json)을 붙였을 경우 정제
        const cleanJsonText = subTitleText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedJson = JSON.parse(cleanJsonText);

        if (!Array.isArray(parsedJson?.captions) || parsedJson.captions.length === 0) {
          console.warn(`[${slotID}] ⛔ LLM 응답 결함. 기본 captions 사용.`);
          captions = fallbackCaptions;
        } else {
          captions = parsedJson.captions;
        }

        const baseMeta = parsedJson?.uploadMeta || {
          title: `${topic} Shorts`,
          description: `Topic: ${topic}`,
          tags: ["shorts", topic.replace(/\s/g, '')]
        };

        // ===================== 출처 남기기 ========================
        const SOURCE_TEXT = {
          KR: "[이 영상의 원본영상 보기]",
          US: "[Watch the original videos]",
          MX: "[Ver los videos originales]"
        };
        const sourceTitle = SOURCE_TEXT[region] || SOURCE_TEXT.US;

        // 💡 [아키텍처 반영] 2. 다운로드 된 inputFiles 배열을 순회하며 URL 리스트 생성
        const urlList = inputFiles
          .map((v, index) => `${index + 1}) https://www.youtube.com/watch?v=${v.videoId}`)
          .join('\n');

        // 💡 [아키텍처 반영] 3. 최종 Description 조합 (LLM 생성 문구 + 출처 + 기본 해시태그)
        uploadMeta = {
          ...baseMeta,
          description: `${slotID}\n${baseMeta.description}\n\n[${sourceTitle}]\n${urlList}\n\n#Shorts #${region}`
        };

        await writeJsonAtomic(path.join(workDir, "uploadMeta.json"), { slotID, topic, parsedJson });
      } catch (err) {
        console.warn(`[${slotID}] ⚠️ LLM 파싱 실패: ${err.message}. 기본값(Fallback) 사용.`);
        captions = fallbackCaptions;

        // Fallback 시에도 출처는 남겨야 합니다.
        const sourceTitle = region === 'KR' ? "이 영상의 원본영상 보기" : "Watch the original videos";
        const urlList = inputFiles.map((v, i) => `${i + 1}) https://youtu.be/${v.videoId}`).join('\n');

        uploadMeta = {
          title: `${topic} 하이라이트`,
          description: `자동 생성 영상: ${topic}\n\n[${sourceTitle}]\n${urlList}`,
          tags: ["shorts"]
        };
      }
      // ===================== 출처 남기기 ========================

      // ==================== Step 4: 오디오(TTS) 데이터 준비 ===============================
      console.log(`[${slotID}] Step 4: 오디오(TTS) 데이터 준비...`);

      const introAudioPath = await ttsService.generateIntroTts(topic, region, outputsDir);

      // 💡 [수정] Drop 전략 폐기! 4개의 영상에 4개의 자막(Caption)을 1:1로 정직하게 매핑합니다.
      const titleInfos = highlightPaths.map((_, i) => ({
        index: i + 1, // 자연스럽게 1, 2, 3, 4 번호가 부여됨
        caption: captions[i] || "Check this out!"
      }));

      // 본문 자막 4개 생성
      const bodyTtsPaths = await ttsService.generateTtsFiles(titleInfos, region, outputsDir);

      // 배열 병합: [인트로오디오, 자막1, 자막2, 자막3, 자막4] -> 총 5개의 오디오 파일
      const ttsPaths = [introAudioPath, ...bodyTtsPaths];

      // =================== Step 5: 통합형 병합 (FFmpeg) // ==========================================
      console.log(`[${slotID}] Step 5: 통합 타이틀 & 하이라이트 병합 중...`);
      const finalOut = path.join(workDir, "final.mp4");

      // 수정된 V2 병합 함수로 모든 데이터(N개의 영상, N-1개의 자막, N개의 오디오)를 그대로 밀어 넣습니다.
      await mergeHighlightsWithIntegratedTitles({
        slotID,
        highlightPaths,         // 하이라이트 영상 원본 배열
        durations: highlightDurations,
        ttsPaths,               // 방금 만든 오디오 배열 (인트로 + 자막)
        titleInfos,             // 자막 데이터 (N-1개)
        outputPath: finalOut,
        topic,        // 💡 통합 인트로를 위해 추가!
        region,                 // 💡 통합 인트로 번역을 위해 추가!
        width: 1080,
        height: 1920,
        fps: 30,
        titleFontPath: titleFontPath,
        moveStart: 1,
        moveEnd: audioFadeInDuration // 기존 파라미터 유지
      });

      // 6) 최종 결과 응답
      console.log(`[${slotID}] ✅ 모든 비디오 공정 완료!`);
      return sendJson(res, 200, {
        ok: true,
        outputFile: "final.mp4",
        outputFileAbs: path.resolve(finalOut),
        uploadMeta,
      });

    } catch (err) {
      console.error(`[${slotID}] ❌ 프로세스 중 치명적 오류 발생:`, err.stack);
      return sendJson(res, 500, { ok: false, error: String(err.message) });
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[video-processor-service] listening on http://localhost:${PORT}`);
});