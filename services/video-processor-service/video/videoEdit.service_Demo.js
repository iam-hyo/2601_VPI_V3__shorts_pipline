// /src/3_services/videoEdit.service_Demo.js
/**
 * [파일 책임]
 * - (Demo) yt-dlp + ffmpeg를 이용한 “다운로드/편집 기능”을 제공합니다.
 *
 * 제공 기능:
 * - exists, ensureDir
 * - downloadVideoIfNeeded            (yt-dlp)
 * - cutSmartHighlight               (ffmpeg, 하이라이트, genemi)
 * - mergeHighlightsWithIntegratedTitles  (ffmpeg filter_complex, 안정적 병합 + fade)
 *
 * ⚠️ 전제:
 * - 시스템에 yt-dlp, ffmpeg가 설치되어 있어야 합니다.
 * - 본 코드는 “학습/구현 이해” 목적의 물리 편집 계층입니다.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
// import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { spawn } from "child_process";
import { promisify } from "node:util";
import os from "os";
import { generateContent } from "../llm/gemini.service.js";

const exec = promisify(execCb);
// const fontConfigDir = path.resolve("data/assets");
// const fontConfigFile = path.join(fontConfigDir, "fonts.conf");

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// const VIDEOEDIT_DEBUG = process.env.VIDEOEDIT_DEBUG === "1";


function getCookiesPath() {
  const v = process.env.YTDLP_COOKIES;   // 예: ./cookies.txt
  if (!v) return null;
  // 서비스 루트(CWD) 기준으로 절대경로로 변환
  return path.isAbsolute(v) ? v : path.resolve(process.cwd(), v);
}


/**
 * [역할] FFmpeg filter 문자열 내부에서 안전하게 쓰기 위한 경로 변환
 * [인자]
 *  - filePath: 원본 경로(상대/절대)
 *  - opts:
 *    - preferRelative: 가능하면 상대경로로 바꿔서 Windows의 "C:" 콜론 문제를 근본 회피 (기본 true)
 * [반환값]
 *  - FFmpeg filter 옵션 값에 넣기 좋은 경로 문자열(슬래시 통일, win 드라이브 콜론 처리)
 */
function fixPathForFfmpegFilter(filePath, opts = {}) {
  const { preferRelative = true } = opts;
  if (!filePath) return "";

  const isWin = os.platform() === "win32";
  const abs = path.resolve(filePath);

  // 1) 가능하면 상대경로로 만들어 'C:' 자체를 제거(가장 안정적)
  if (preferRelative) {
    try {
      const rel = path.relative(process.cwd(), abs);
      const looksAbsoluteWin = /^[A-Za-z]:[\\/]/.test(rel);
      if (!looksAbsoluteWin) {
        return rel.split(path.sep).join("/");
      }
    } catch {
      // fallback
    }
  }

  // 2) fallback: 절대경로를 filter 파서가 먹을 수 있게 변환
  if (isWin) {
    const slash = abs.replace(/\\/g, "/");
    // drawtext 등 filter 내부에서는 ':'가 옵션 구분자이므로 드라이브 콜론을 \:로 보호
    // C:/Users/... -> C\:/Users/...
    return slash.replace(/^([A-Za-z]):\//, "$1\\:/");
  }

  // Linux/macOS: 절대경로 그대로 OK
  return abs;
}

/**
 * [역할] FFmpeg 실행(spawn) 결과를 Promise로 반환
 * [인자]
 *  - args: ffmpeg 인자 배열 (예: ["-y", "-i", "...", ...])
 *  - options:
 *    - cwd: 작업 디렉토리
 *    - env: 환경변수
 * [반환값]
 *  - { code, stdout, stderr }
 */
function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    ff.stdout.on("data", (d) => (stdout += d.toString()));
    ff.stderr.on("data", (d) => (stderr += d.toString()));

    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else {
        const e = new Error(`FFmpeg exited with code ${code}`);
        e.code = code;
        e.stderr = stderr;
        e.stdout = stdout;
        reject(e);
      }
    });
  });
}


/**
 * [유틸] 파일이 "실제로" 생성되었는지(0바이트/깨진 파일 방지)
 */
async function existsNonEmpty(filePath, minBytes = 1024) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size >= minBytes;
  } catch {
    return false;
  }
}


/* =======================================================================================
 * 공통 유틸
 * ======================================================================================= */

/**
 * [함수 책임] 파일 존재 여부 확인(비동기)
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * [함수 책임] 디렉토리 생성(없으면 생성)
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * [헬퍼] 윈도우 경로의 콜론(:) 및 백슬래시(\)를 FFmpeg 필터용으로 변환
 */
export function fixPathForFfmpeg(p, mode = "input") {
  if (!p) return "";

  // 1) 절대경로화 + 슬래시 통일 (윈도우 역슬래시 문제 방지)
  let abs = path.resolve(p).replace(/\\/g, "/");

  // 2) 사용처별 추가 처리
  if (mode === "drawtextFontfile") {
    if (process.platform === "win32") {
      abs = abs.replace(/^([A-Za-z]):/, "$1\\:");
    } // 윈도우 드라이브 "C:"의 콜론을 -> "C\:"로 변환
    abs = abs.replace(/'/g, "\\'"); // 경로에 "'"가 있을 때만 처리 필요 (거의 없지만 안전하게)
  }

  return abs;
}
/**
 * [유틸] Windows 경로를 FFmpeg가 안전하게 읽을 수 있도록 '/'로 치환
 * @param {string} p
 * @returns {string}
 */
function normalizeFontPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

/* =======================================================================================
 * 1) 다운로드 (yt-dlp)
 * ======================================================================================= */

/**
 * [다운로드] 유튜브 영상을 로컬 MP4 파일로 저장 (멱등)
 * - 도구: yt-dlp
 * - 이미 다운로드된 파일이 있다면 실행하지 않고 경로만 반환
 *
 * @param {{ videoId: string, outDir: string }} args
 * @returns {Promise<string>} 저장된 파일 경로
 */
export async function downloadVideoIfNeeded({ videoId, outDir, cookiesPath }) {
  await ensureDir(outDir);

  const outPath = path.join(outDir, `${videoId}.mp4`);
  const tmpPath = path.join(outDir, `${videoId}.part.mp4`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const stat = await safeStat(outPath);
  if (stat && stat.size >= 30_000) return outPath;

  const cookiesAbs = getCookiesPath();
  const cookiesArg = cookiesAbs ? `--cookies "${cookiesAbs}"` : "";

  // 수정된 포인트:
  // 1. -S "res:1080,ext:mp4:m4a" -> 1080p 해상도를 최우선으로 찾고 mp4 컨테이너 선호
  // 2. --format-sort-force -> 설정한 우선순위를 강력하게 적용
  const formatArg = `-f "bv*[height<=1080]+ba/b[height<=1080]"`; // 최대 1080p까지의 최고 화질

  const cmd =
    `yt-dlp ${cookiesArg} ` +
    `${formatArg} ` +
    `-S "res:1080,vcodec:h264,acodec:aac" ` + // 해상도 1080p 우선, 그 다음 코덱 순
    `--merge-output-format mp4 ` +
    `-o "${tmpPath}" "${url}"`;

  console.log(`[videoEdit.demo] 고화질 다운로드 시도: ${videoId}`);
  await exec(cmd);

  // 5) 결과 검증 후 확정 저장
  const tmpStat = await safeStat(tmpPath);
  if (!tmpStat || tmpStat.size < 30_000) {
    throw new Error(`[download invalid] file too small: ${tmpPath}`);
  }
  await fs.rename(tmpPath, outPath);

  return outPath;
}

/** 파일 stat 안전조회 */
async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

/* =======================================================================================
 * 2) 하이라이트 추출 (ffmpeg)
 * ======================================================================================= */
/**
 * [하이라이트] 가변 시작 시간 대응 하이라이트 컷
 */
export async function cutSmartHighlight({ inputPath, outputPath, startTime, duration = 10 }) {
  // [수정] startTime 형식이 HH:MM:SS:mmm 일 경우 HH:MM:SS.mmm으로 교정
  let formattedStartTime = startTime;
  if (formattedStartTime && typeof formattedStartTime === 'string') {
    // 마지막에 등장하는 콜론(:)을 마침표(.)로 변경 (정규식 사용)
    // 00:00:23:119 -> 00:00:23.119
    const parts = formattedStartTime.split(':');
    if (parts.length === 4) {
      formattedStartTime = `${parts[0]}:${parts[1]}:${parts[2]}.${parts[3]}`;
    }
  }

  // 교정된 formattedStartTime 사용
  const inputSeek = formattedStartTime ? `-ss ${formattedStartTime}` : `-sseof -${duration}`;

  const cmd = `ffmpeg -y ${inputSeek} -i "${inputPath}" -t ${duration} -c copy "${outputPath}"`;

  console.log(`[FFmpeg Execution] ${cmd}`); // 디버깅을 위해 로그 출력 권장
  await exec(cmd);
  return outputPath;
}


// [신규] 하이라이트 선정 분석 로그 저장 (데모용)
async function logHighlightDecision(videoId, analysis, fullSubtitle) {
  const logDir = path.join(process.cwd(), 'data', 'logs', 'highlights');
  if (!existsSync(logDir)) await fs.mkdir(logDir, { recursive: true });

  const logEntry = {
    timestamp: new Date().toISOString(),
    videoId,
    decision: analysis,
    // 필요 시 자막 전체를 저장하거나 요약본 저장
    subtitleSnippet: fullSubtitle.slice(0, 2000)
  };

  const logPath = path.join(logDir, `${videoId}_decision.json`);
  await fs.writeFile(logPath, JSON.stringify(logEntry, null, 2));
  console.log(`[VPI-Logger] 하이라이트 결정 로그 저장 완료: ${logPath}`);
}

/**
 * [하이라이트] Gemini 시맨틱 타임라인 분석
 */
export async function getSmartHighlightTimestamps(subPath, videoId) {
  if (!subPath) return null;
  const subtitleText = await fs.readFile(subPath, "utf-8");

  const prompt = `
    유튜브 자막을 분석하여 숏폼으로 제작할 '골든 하이라이트' 구간을 선정하라.
    
    [핵심 제약 사항]
    1. 시간: 반드시 10초일 필요 없으며, 문맥이 끝나는 지점에 맞춰 8~18초 사이를 권장한다. 시작 시점은 문장이 자연스럽게 시작되는 부분으로 선정하라.
    2. 광고 제거: "구독", "좋아요", "알림 설정", "더보기란", "고정 댓글", "후원", "광고" 등의 멘트가 포함된 구간은 기피대상으로 간주하라. 
    3. 논리적 완결성(중요): 끝나는 지점에는 흐름의 완결성이 포함되도록 선정하여라. 핵심문구 혹은 마무리 멘트가 포함되면 좋다. 문장이 중간에 끊기지 않고 결론이나 반전이 포함된 구간을 우선하라.

    [결과 형식]
    반드시 아래 JSON 포맷으로만 응답하라:
    특히 startTime은 FFmpeg 표준인 'HH:MM:SS.mmm' 형식을 엄수하라 (초와 밀리초 사이는 반드시 마침표 '.' 사용).
    {"startTime": "00:00:23.119", "endTime": "00:00:35.619", "duration": 12.5, "reason": "이유 설명", "isAdFree": true}

    [자막 데이터]
    ${subtitleText.slice(0, 5000)}
  `;

  try {
    const response = await generateContent("gemini-3.1-flash-lite-preview", prompt, true);
    const result = JSON.parse(response);

    // 로깅 데이터 구성 (2번 항목 대응)
    await logHighlightDecision(videoId, result, subtitleText);

    return result;
  } catch (err) {
    console.error("[SmartHighlight] 분석 실패:", err);
    return { startTime: null, duration: 10, reason: "Fallback to default" };
  }
}



/* =======================================================================================
 * 3) 타이틀 카드 생성 (ffmpeg)
 * ======================================================================================= */

/**
 * [고도화 병합 V2] 
 * 1. 0.8s~1.2s 구간 동안 중앙에서 상단으로 부드럽게 슬라이딩 (1번 해결)
 * 2. 0.8s까지는 배경음이 작게(20%) 들리다가 이후 1.5s간 길게 페이드인 (4번 해결)
 */
export async function mergeHighlightsWithIntegratedTitles(args) {
  const {
    highlightPaths,
    durations = [],
    ttsPaths,
    titleInfos,
    outputPath,
    width = 1080,
    height = 1920,
    fps = 30,
    fadeSec = 0.3,
    sampleRate = 44100,
    titleFontPath,
    slotID = "UNKNOWN"
  } = args;

  const wrapText = (text, maxChars = 18) => {
    const words = text.split(' ');
    let lines = [];
    let currentLine = "";
    words.forEach(word => {
      if ((currentLine + word).length > maxChars) {
        lines.push(currentLine.trim());
        currentLine = word + " ";
      } else {
        currentLine += word + " ";
      }
    });
    lines.push(currentLine.trim());
    return lines.join('\\n');
  };

  const n = highlightPaths.length;
  // 입력 순서: [영상1, 영상2, 영상3, 영상4, TTS1, TTS2, TTS3, TTS4]
  const inputArgs = [
    ...highlightPaths.map(p => `-i "${path.resolve(p)}"`),
    ...ttsPaths.map(p => `-i "${path.resolve(p)}"`)
  ].join(" ");
  const filters = [];

  for (let i = 0; i < n; i++) {
    const rawCaption = titleInfos[i].caption;
    const safeCaption = `${titleInfos[i].index}. ${rawCaption}`
      .replace(/'/g, "'\\\\\\''")
      .replace(/:/g, "\\\\:"); // drawtext 콜론 탈출 강화
    const fontPath = titleFontPath.replace(/\\/g, '/');
    const currentDur = durations[i] || 10.0; // 해당 클립의 동적 길이 사용
    const fadeOutStart = (currentDur - fadeSec).toFixed(1);

    // --- [1번 해결: 애니메이션 수식 설계] ---
    const moveStart = 0.8;
    const moveEnd = 1.2;
    const moveDur = (moveEnd - moveStart).toFixed(1); // 0.4초

    const startY = `(h-th)/2`; // 중앙
    const endY = `180`;        // 상단
    const startFS = 85;        // 시작 크기
    const endFS = 55;          // 종료 크기

    // Y 좌표: 0.8초부터 1.2초까지 선형 이동
    const animY = `if(lt(t,${moveStart}), ${startY}, if(lt(t,${moveEnd}), ${startY}-(${startY}-${endY})*(t-${moveStart})/${moveDur}, ${endY}))`;
    // 폰트 크기: 0.8초부터 1.2초까지 선형 축소
    const animFS = `if(lt(t,${moveStart}), ${startFS}, if(lt(t,${moveEnd}), ${startFS}-(${startFS}-${endFS})*(t-${moveStart})/${moveDur}, ${endFS}))`;

    // --- [비디오 필터] ---
    let vFilter = `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`;

    // 암전 레이어 (애니메이션에 맞춰 딤 처리)
    vFilter += `,drawbox=y=0:color=black@0.8:width=iw:height=ih:t=fill:enable='lt(t,${moveEnd})'`;

    // 2) [수정] 1.2초 후 배경 박스 위치를 텍스트 위치(180)에 맞춤
    // 박스 높이가 220이므로 y=130 정도면 y=180인 텍스트의 위아래를 적절히 감쌉니다.
    const boxY = 130;
    const boxHeight = 220;
    vFilter += `,drawbox=y=${boxY}:color=black@0.6:width=iw:height=${boxHeight}:t=fill:enable='gt(t,${moveEnd})'`;

    // 텍스트 필터 (애니메이션 적용)
    // 3) 텍스트 정중앙 배치 (drawtext 부분)
    vFilter += `,drawtext=text='${safeCaption}':fontfile='${fontPath}':fontcolor=white:`;
    vFilter += `fontsize='${animFS}':line_spacing=15:`;
    vFilter += `x=(w-text_w)/2:y='${animY}':expansion=none`;

    vFilter += `,fade=t=out:st=${fadeOutStart}:d=${fadeSec}[v${i}]`;
    filters.push(vFilter);

    // --- [오디오 필터 고도화] ---
    // i: 하이라이트 오디오 인덱스, n+i: TTS 오디오 인덱스
    let aFilter = `[${i}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`;

    // 1. 하이라이트 배경음 처리 (0.8초까지 20% 볼륨, 이후 페이드인)
    aFilter += `,volume=enable='lt(t,0.8)':volume=0.2,afade=t=in:st=0.8:d=1.5`;

    // 2. TTS와 믹싱 (amix)
    // tts 오디오([n+i:a])를 가져와서 하이라이트 오디오와 섞습니다. 속도 x1.2배: atempo=1.2
    // TTS는 0.2초 정도 살짝 늦게 나오게(adelay) 하면 더 자연스럽습니다. 100|100 -> 왼쪽 오른쪽 
    const ttsIndex = n + i;
    const ttsFilter = `[${ttsIndex}:a]atempo=1.2,adelay=80|80,aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo[tts${i}]`;
    filters.push(ttsFilter);

    aFilter += `[bg${i}];[bg${i}][tts${i}]amix=inputs=2:duration=first:dropout_transition=2`;

    // 3. 최종 페이드 아웃
    aFilter += `,afade=t=out:st=${fadeOutStart}:d=${fadeSec}[a${i}]`;

    filters.push(aFilter);
  }

  const concatInputs = highlightPaths.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${n}:v=1:a=1[vout][aout]`);

  const filterComplex = filters.join(";");
  const cmd = [
    `ffmpeg -y ${inputArgs}`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264`,
    `-preset medium`,    // 품질 향상 (superfast -> medium)
    `-crf 18`,           // 품질 향상 (23 -> 18)
    `-pix_fmt yuv420p`,
    `-c:a aac`,
    `-b:a 192k`,
    `"${path.resolve(outputPath)}"`
  ].join(" ");

  console.log(`[${slotID}] 🚀 고도화 V2: 슬라이딩 애니메이션 & 사운드 믹스 적용`);
  await exec(cmd);
}


/**
 * [신규] 자막 다운로드 (yt-dlp 활용)
 */
export async function downloadSubtitles(videoId, outDir) {
  const subPath = path.join(outDir, `${videoId}.ko.srt`);
  if (existsSync(subPath)) return subPath;

  const cookiesAbs = getCookiesPath();
  const cookiesArg = cookiesAbs ? `--cookies "${cookiesAbs}"` : "";

  // --write-auto-subs: 자동 자막, --convert-subs srt: SRT 변환
  const cmd = `yt-dlp ${cookiesArg} --write-auto-subs --sub-lang ko --convert-subs srt --skip-download -o "${path.join(outDir, videoId)}" "https://www.youtube.com/watch?v=${videoId}"`;

  try {
    await exec(cmd);
    return existsSync(subPath) ? subPath : null;
  } catch (err) {
    console.warn(`[videoEdit] 자막 다운로드 실패 (자막이 없을 수 있음): ${err.message}`);
    return null;
  }
}

