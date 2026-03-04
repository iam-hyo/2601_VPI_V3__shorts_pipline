/** .\services\video-processor-service\src\server.js
 * [파일 책임] 
 * - /process 요청을 받아 "다운로드(yt-dlp) → 하이라이트 → 타이틀카드 → 병합"을 수행하고
 *   최종 파일 경로 및 업로드 메타를 반환한다.
 */
import "./env.js"; // ✅ 최상단에 먼저!
import http from "node:http";
import url from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { readJsonSafe } from "./utils.js"
import { generateTtsFiles } from "../audio/tts.service.js";

// ✅ 업데이트된 Demo 서비스 사용
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

const titleFontPath = resolveAssetPath("memomentKkukkkuk.ttf");

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
    let body;
    try {
      body = await readBody(req);
      console.log("================ [DEBUG: Incoming Body] ================");
      console.log(JSON.stringify(body, null, 2));
      console.log("========================================================");
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON Body" });
    }

    const { workDir, topic = "", slotID = "UNKNOWN", region, HIGHLIGHT_SECOND } = body;
    const bodySources = Array.isArray(body.sources) ? body.sources : [];
    const languageMap = {
      'KR': 'Korean (한국어)',
      'US': 'English (영어)',
      'MX': 'Spanish (스페인어)'
    };
    const targetLanguage = languageMap[region] || 'English (영어)';
    console.log(`[${slotID}] 📥 /process 요청 수신 (region: ${region}, targetLanguage: ${targetLanguage}),HIGHLIGHT_SECOND: ${HIGHLIGHT_SECOND}`);
    console.log(`[${slotID}] 요청 body:`, { ...body, sources: `Array(${bodySources.length})` }); // sources 배열 길이만 로그에 표시

    if (!workDir) {
      console.error(`[${slotID}] 에러: workDir이 요청에 없습니다.`);
      return sendJson(res, 400, { ok: false, error: "workDir is required" });
    }

    console.log(`[${slotID}] 🚀 비디오 제작 프로세스 시작 (Topic: ${topic})`);

    try {
      // 0) 디렉토리 구성
      const inputsDir = path.join(workDir, "inputs");
      const outputsDir = path.join(workDir, "outputs");
      await ensureDir(inputsDir);
      await ensureDir(outputsDir);

      // 1) 소스 결정 및 다운로드
      console.log(`[${slotID}] Step 1: 비디오 소스 다운로드 및 로컬 확인 중...`);
      const selectedSources = await resolveSelectedSources({ workDir, bodySources });
      // [수정] 소스가 없는데 강행하면 undefined[0] 에러가 발생하므로 여기서 차단
      if (!selectedSources || selectedSources.length < 1) {
        console.error(`[${slotID}] 에러: 소스 영상이 없습니다.`);
        return sendJson(res, 400, { ok: false, error: "No source videos found." });
      }
      else if (selectedSources.length < 3) {
        throw new Error(`사용 가능한 소스 영상이 부족합니다. (현재: ${selectedSources.length}개)`);
      }

      const inputFiles = [];
      for (let i = 0; i < selectedSources.length; i++) {
        const s = selectedSources[i];
        const localPath = await downloadVideoIfNeeded({ videoId: s.videoId, outDir: inputsDir });
        inputFiles.push({ ...s, inputPath: localPath });
      }
      const videoCount = inputFiles.length; // 동적 개수 확보

      // 2) 하이라이트 추출
      console.log(`[${slotID}] Step 2: Gemini 시맨틱 분석 및 하이라이트 컷팅 시작 (총 ${videoCount}개)...`);
      const highlightPaths = [];
      const highlightDurations = []; // [신규] 동적 길이를 담을 배열 선언

      for (let i = 0; i < 4; i++) {
        const source = inputFiles[i];
        const outPath = path.join(outputsDir, `highlight_${i + 1}.mp4`);

        const subPath = await downloadSubtitles(source.videoId, inputsDir);
        const analysis = await getSmartHighlightTimestamps(subPath); // Gemini 분석

        const actualDuration = analysis?.duration || HIGHLIGHT_SECOND; // 분석 결과가 없으면 기본값(11.2) 사용

        await cutSmartHighlight({
          inputPath: source.inputPath,
          outputPath: outPath,
          startTime: analysis?.startTime,
          duration: actualDuration,
        });

        highlightPaths.push(outPath);
        highlightDurations.push(actualDuration); // [추가] 각 하이라이트의 실제 길이를 저장
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
          `캡션은 자극적이고 키치한 ${targetLanguage} 후킹 문구로 작성하라(어그로 허용).`,
          "문장보다 명사구(noun phrase) 형태를 권장한다.",
          "각 캡션은 4단어 이하를 권장한다(최대 6단어).",
          "대주제(topic)를 그대로 반복하지 말고, 각 영상 고유의 특징을 반영하라.",
          `반드시 모든 텍스트 결과물은 ${targetLanguage}로 작성해야 한다.`, // 강제성 추가
          "잡담/설명/마크다운 없이 outputFormat에 맞는 JSON만 반환하라.",
        ],
        outputFormat: {
          captions: ["string", "string", "string", "string"],
          uploadMeta: { title: "string", description: "string", tags: ["string"] },
        },
      };

      let uploadMeta;
      let captions;
      const defaultCaptions = ["WOW", "NO WAY", "INSANE", "UNREAL", "AMAZING", "LEGEND"]; //향후 그냥 에러로 처리
      const fallbackCaptions = defaultCaptions.slice(0, inputFiles.length);

      try {
        console.log(`[${slotID}] LLM 메타데이터 생성 및 시작...✍️`);

        const subTitleText = await llm.generateJson(prompt);
        const parsedJson = JSON.parse(subTitleText);

        if (!Array.isArray(parsedJson?.captions)) {
          // 생성된 제목 유효성 검사
          console.warn(`[${slotID}] ⛔LLM 응답에 captions가 없거나 배열이 아님. 기본 captions 사용. (captions=${JSON.stringify(parsedJson?.captions)})`);
          captions = fallbackCaptions;
        } else if (parsedJson.captions.length === 0) {
          console.warn(`[${slotID}] ⛔LLM captions 배열이 비어있음. 기본 captions 사용.`);
          captions = fallbackCaptions;
        } else {
          captions = parsedJson.captions;
        }

        // 업로드 메타도 방어 로직 추가
        const baseMeta = parsedJson?.uploadMeta || {
          title: `${topic} Shorts`,
          description: `Topic: ${topic}`,
          tags: ["shorts", topic]
        };

        uploadMeta = {
          ...baseMeta,
          description: `${slotID}\n${baseMeta.description}`
        };

        // 중간 상태 저장 (디버깅용)
        await writeJsonAtomic(path.join(workDir, "subT_result.json"), { slotID, topic, parsedJson });
        console.log(`[${slotID}] ✍️ LLM 메타데이터 생성 및 저장 완료`);
      } catch (err) {
        console.warn(`[${slotID}] LLM 생성 실패: ${err.message}. 기본값 사용.`);
        captions = fallbackCaptions
        uploadMeta = { title: `${topic} 하이라이트`, description: `자동 생성 영상: ${topic}`, tags: ["shorts"] };
      }

      // 4) 타이틀 카드 정보 준비 (이제 파일을 생성하지 않고 정보만 정리합니다)
      console.log(`[${slotID}] Step 4: 타이틀 카드 데이터 준비...`);
      const titleInfos = highlightPaths.map((_, i) => ({
        index: i + 1,
        caption: captions[i] || "Check this out!"
      }));
      const ttsPaths = await generateTtsFiles(titleInfos, region, outputsDir);

      // 5) 통합형 병합 (FFmpeg)
      // 기존 mergeTitleAndHighlightsWithFade 호출을 삭제하고 아래로 교체합니다.
      console.log(`[${slotID}] Step 5: 통합 타이틀 & 하이라이트 병합 중...`);
      const finalOut = path.join(workDir, "final.mp4");

      await mergeHighlightsWithIntegratedTitles({
        slotID,
        highlightPaths,      // 이미 추출된 11.2초 하이라이트 파일들의 경로 배열
        highlightDurations,
        durations: highlightDurations,
        titleInfos,          // 방금 만든 {index, caption} 배열
        outputPath: finalOut,
        highlightSec: HIGHLIGHT_SECOND,
        titleFontPath,       // 폰트 경로 (준비되어 있어야 함)
        width: 1080,
        height: 1920,
        fps: 30,
        ttsPaths
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
