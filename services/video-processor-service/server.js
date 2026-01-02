/** .\services\video-processor-service\server.js
 * [파일 책임] 
 * - /process 요청을 받아 "다운로드(yt-dlp) → 하이라이트 → 타이틀카드 → 병합"을 수행하고
 *   최종 파일 경로 및 업로드 메타를 반환한다.
 */

import http from "node:http";
import url from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

// ✅ 업데이트된 Demo 서비스 사용
import {
  ensureDir,
  downloadVideoIfNeeded,
  cutLastSecondsIfNeeded,
  createTitleCardIfNeeded,
  mergeTitleAndHighlightsWithFade,
} from "./videoEdit.service_Demo.js";

// (예시) 기존에 있던 유틸들이라고 가정
// import { readBody, sendJson } from "./http.util.js";
// import llm from "./llm.js";

/**
 * [추가] 요청 바디를 읽어오는 헬퍼 함수
 */
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * [추가] JSON 응답을 보내는 헬퍼 함수
 */
function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function mustExist(p) {
  return !!p && existsSync(p);
}

async function readJsonSafe(p) {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * [함수 책임]
 * - body.sources 또는 workDir/meta.json에서 "선택된 소스 영상 리스트"를 얻는다.
 * - 우선순위: body.sources(명시) > meta.json(selected)
 *
 * @param {{ workDir: string, bodySources: any[] }} args
 * @returns {Promise<Array<{videoId:string,title?:string,channelTitle?:string,description?:string,inputPath?:string}>>}
 */
async function resolveSelectedSources({ workDir, bodySources }) {
  // 1) body.sources가 videoId를 가지고 있으면 그것을 우선 사용
  if (Array.isArray(bodySources) && bodySources.length > 0 && bodySources[0]?.videoId) {
    return bodySources;
  }

  // 2) meta.json에서 selected 읽기
  const metaPath = path.join(workDir, "meta.json");
  const meta = await readJsonSafe(metaPath);
  const selected = meta?.selected || meta?.selectedSourceVideos || [];
  return Array.isArray(selected) ? selected : [];
}

const PORT = process.env.PORT || 8787;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "POST" && parsed.pathname === "/process") {
    try {
      const body = await readBody(req);

      const workDir = body.workDir;
      const topic = body.topic || "";
      const bodySources = Array.isArray(body.sources) ? body.sources : [];

      if (!workDir) return sendJson(res, 400, { ok: false, error: "workDir is required" });

      // ✅ selectedSources: [{videoId,title,channelTitle,description}, ...]
      const selectedSources = await resolveSelectedSources({ workDir, bodySources });

      if (selectedSources.length < 4) {
        return sendJson(res, 400, { ok: false, error: "selectedSources는 4개 이상 필요합니다.(videoId 기반)" });
      }

      // 0) 디렉토리 구성
      const inputsDir = path.join(workDir, "inputs");
      const outputsDir = path.join(workDir, "outputs");
      await ensureDir(inputsDir);
      await ensureDir(outputsDir);

      // 1) 다운로드(yt-dlp) 또는 (호환) inputPath 직접 사용
      // - 만약 selectedSources에 inputPath가 있고 파일이 실제로 존재하면 다운로드를 스킵할 수 있게 “겸용” 처리
      const inputFiles = [];
      for (let i = 0; i < 4; i++) {
        const s = selectedSources[i];

        if (s.inputPath && mustExist(s.inputPath)) {
          // (구버전 호환) 이미 로컬 파일이 있다면 그대로 사용
          inputFiles.push({ ...s, inputPath: s.inputPath });
          continue;
        }

        // (신버전) videoId 기반 다운로드
        const localPath = await downloadVideoIfNeeded({ videoId: s.videoId, outDir: inputsDir });
        inputFiles.push({ ...s, inputPath: localPath });
      }

      // 2) 하이라이트(마지막 N초)
      const highlightSec = 10;
      const highlightPaths = [];

      for (let i = 0; i < 4; i++) {
        const outPath = path.join(outputsDir, `highlight_${i + 1}.mp4`);
        await cutLastSecondsIfNeeded({
          inputPath: inputFiles[i].inputPath,
          outputPath: outPath,
          seconds: highlightSec,
        });
        highlightPaths.push(outPath);
      }

      // 3) LLM: 캡션 + 업로드 메타 (description까지 프롬프트에 녹일 수 있음)
      const prompt = {
        topic,
        sources: inputFiles.map((v) => ({
          title: v.title,
          channelTitle: v.channelTitle,
          description: v.description,
        })),
        task: [
          "4개의 하이라이트(각 10초)를 1개의 쇼츠로 만든다.",
          "각 하이라이트 앞에 1.2초 타이틀 카드가 들어간다.",
          "타이틀 카드에 들어갈 짧고 후킹되는 캡션 4개를 만들어라(각 1~6단어).",
          "최종 업로드 제목/설명/태그(tags 배열)를 만들어라.",
        ],
        outputFormat: {
          captions: ["string", "string", "string", "string"],
          uploadMeta: { title: "string", description: "string", tags: ["string"] },
        },
      };

      let parsedJson = null;
      try {
        const llmText = await llm.generateJson(prompt);
        parsedJson = JSON.parse(llmText);
      } catch {
        parsedJson = null;
      }

      const captions = Array.isArray(parsedJson?.captions)
        ? parsedJson.captions.slice(0, 4)
        : ["WOW", "NO WAY", "INSANE", "MUST WATCH"];

      const uploadMeta = parsedJson?.uploadMeta || {
        title: `${topic} 하이라이트`,
        description: `자동 생성 영상: ${topic}`,
        tags: ["shorts", "trend"],
      };

      // 4) 타이틀 카드 생성 (✅ 시그니처 이미지 + 서브 폰트는 Demo 함수 내부에서 처리)
      const titleCardPaths = [];
      for (let i = 0; i < 4; i++) {
        const p = await createTitleCardIfNeeded({
          outDir: outputsDir,
          index: i + 1,
          caption: captions[i] || "",
          // ✅ 서브타이틀 예시: 채널명 또는 토픽
          subCaption: inputFiles[i].channelTitle || topic,
          durationSec: 1.2,
        });
        titleCardPaths.push(p);
      }

      // 5) 병합 (fade 트랜지션)
      const finalOut = path.join(outputsDir, "final.mp4");
      await mergeTitleAndHighlightsWithFade({
        titleCardPaths,
        highlightPaths,
        outputPath: finalOut,
        durationSec: 1.2,
        highlightSec,
        fadeSec: 0.15,
      });

      // 6) (선택) 최종 결과를 “정해진 위치(정재진 위치)”로 복사
      // - 운영 환경마다 경로가 다르므로 ENV로 분리 권장
      // - 예: VIDEO_PUBLISH_DIR="/data/final_outputs"
      let finalAbs = path.resolve(finalOut);
      const publishDir = process.env.VIDEO_PUBLISH_DIR;
      if (publishDir) {
        await ensureDir(publishDir);
        const outName = `final_${Date.now()}.mp4`;
        const dest = path.join(publishDir, outName);
        await fs.copyFile(finalOut, dest);
        finalAbs = path.resolve(dest);
      }

      return sendJson(res, 200, {
        ok: true,
        outputFile: "outputs/final.mp4",
        outputFileAbs: finalAbs,
        uploadMeta,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`[video-processor-service] listening on http://localhost:${PORT}`);
});
