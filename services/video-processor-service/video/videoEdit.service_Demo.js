// /src/3_services/videoEdit.service_Demo.js
/**
 * [파일 책임]
 * - (Demo) yt-dlp + ffmpeg를 이용한 “다운로드/편집 기능”을 제공합니다.
 *
 * 제공 기능:
 * - exists, ensureDir
 * - downloadVideoIfNeeded            (yt-dlp)
 * - cutLastSecondsIfNeeded           (ffmpeg, 하이라이트)
 * - createTitleCardIfNeeded          (ffmpeg, 타이틀 카드 + 시그니처 이미지 + 서브타이틀 폰트)
 * - mergeTitleAndHighlightsWithFade  (ffmpeg filter_complex, 안정적 병합 + fade)
 *
 * ⚠️ 전제:
 * - 시스템에 yt-dlp, ffmpeg가 설치되어 있어야 합니다.
 * - 본 코드는 “학습/구현 이해” 목적의 물리 편집 계층입니다.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { spawn } from "child_process";
import { promisify } from "node:util";
import os from "os";

const exec = promisify(execCb);
// const fontConfigDir = path.resolve("data/assets");
// const fontConfigFile = path.join(fontConfigDir, "fonts.conf");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIDEOEDIT_DEBUG = process.env.VIDEOEDIT_DEBUG === "1";


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
 * [유틸] drawtext에 들어가는 문자열 escape
 * - FFmpeg drawtext는 특수문자에 민감합니다.
 * - 특히 \, ', : 의 escape 순서가 중요합니다.
 * @param {string} text
 * @returns {string}
 */
function escapeForDrawtext(text) {
  // FFmpeg drawtext는 특수문자에 민감합니다.
  // - 특히 \\, ', : 는 깨지기 쉬우니 최소 escape만 적용합니다.
  // - 이 구현은 (filter_complex를 큰따옴표로 감싼) 현재 명령 구성과 가장 호환이 좋습니다.
  return String(text ?? "")
    .replace(/\\/g, "\\\\")   // 1) 백슬래시 탈출
    .replace(/'/g, "\\'")    // 2) 싱글쿼트 탈출
    .replace(/:/g, "\\:")         // 3) 콜론 탈출
    .replace(/\n/g, "\\n");      // 4) 줄바꿈(있다면)
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
  const tmpPath = path.join(outDir, `${videoId}.part.mp4`); // 임시 파일 권장
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // 1) 이미 파일이 있고 충분히 크면 스킵
  const stat = await safeStat(outPath);
  if (stat && stat.size >= 30_000) {
    console.log(`[videoEdit.demo] download skip (exists): ${videoId}`);
    return outPath;
  }

  // 2) (깨짐 가능) 파일이 있는데 너무 작으면 삭제
  if (stat && stat.size < 30_000) {
    try { await fs.unlink(outPath); } catch { }
  }
  // 임시 파일도 정리
  try { await fs.unlink(tmpPath); } catch { }

  // 3) cookies 경로 (환경변수에서 읽기)
  const cookiesAbs = getCookiesPath();
  const cookiesArg = cookiesAbs ? `--cookies "${cookiesAbs}"` : "";

  // 4) 다운로드 명령어 구성
  // -S: 포맷 선택 우선순위(편집 호환성: h264+aac 우선)
  // --merge-output-format mp4: 최종 mp4로 머지
  // -o: 임시 파일로 받고 성공 후 rename
  const jsRuntimeArg = `--js-runtimes "node:/usr/bin/node"`; // 환경에 맞게 경로 조정
  const formatArg = `-f "bv*+ba/b"`;                         // 비디오+오디오 병합 우선, 아니면 단일(best) 폴백
  const clientArg = `--extractor-args "youtube:player_client=android"`;

  const cmd =
    `yt-dlp ${cookiesArg} ${jsRuntimeArg} ` +
    `${formatArg} ${clientArg} ` +
    `-S "vcodec:h264,acodec:aac" ` +
    `--merge-output-format mp4 ` +
    `-o "${tmpPath}" "${url}"`;

  console.log(`[videoEdit.demo] 다운로드중..: ${videoId}`);
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
 * [자르기] 영상의 마지막 N초를 잘라내어 하이라이트 생성 (멱등)
 *
 * - 도구: ffmpeg
 * - 방식: -sseof -N (파일 끝에서 N초 전으로 시킹) + -c copy(스트림 복사)
 *
 * ⚠️ 주의:
 * - -c copy는 “코덱/타임베이스” 차이가 있으면 후속 병합에서 이슈가 날 수 있습니다.
 * - 최종 병합은 filter_complex 기반으로 재인코딩(안정성↑)하는 mergeTitleAndHighlightsWithFade를 사용합니다.
 *
 * @param {{ inputPath: string, outputPath: string, seconds?: number }} args
 * @returns {Promise<string>}
 */
export async function cutLastSecondsIfNeeded({ inputPath, outputPath, seconds = 10 }) {
  if (await existsNonEmpty(outputPath, 50_000)) {
    console.log(`[videoEdit.demo] highlight skip (exists): ${outputPath}`);
    return outputPath;
  }

  const cmd = `ffmpeg -y -sseof -${seconds} -i "${inputPath}" -t ${seconds} -c copy "${outputPath}"`;
  console.log(`[videoEdit.demo] cut highlight: ${path.basename(outputPath)}`);
  await exec(cmd);
  return outputPath;
}

/* =======================================================================================
 * 3) 타이틀 카드 생성 (ffmpeg)
 * ======================================================================================= */

/**
 * [타이틀 카드 생성] 1.2초짜리 타이틀 카드 영상 생성 (멱등)
 *
 * 요구사항 반영:
 * 1) 시그니처(프로필) 이미지 overlay:
 *    - 기본 경로: ./data/assets/5토끼_유튜브 프로필.png
 *    - 위치: 화면 중앙 하단부(가독성 고려)
 * 2) 서브타이틀 폰트:
 *    - 기본 폰트: ./data/assets/memomentKkukkkuk.ttf
 * 3) (추후) 배경 이미지 삽입 가능하도록 주석 처리
 *
 * @param {{
 *   outDir: string,
 *   index: number,
 *   caption: string,
 *   subCaption?: string,
 *   durationSec?: number,
 *   width?: number,
 *   height?: number,
 *   fps?: number,
 *   signatureImagePath?: string,
 *   signatureSize?: number,
 *   subtitleFontPath?: string,
 *   titleFontPath?: string,
 * }} args
 * @returns {Promise<string>} 생성된 mp4 경로
 */
export async function createTitleCardIfNeeded(args) {
  const {
    outDir,
    index,
    caption,
    durationSec = 1.2,
    width = 1080,
    height = 1920,
    fps = 30,

    signatureImagePath,
    signatureSize = 220,

    titleFontPath = "",
    slotID = "UNKNOWN",

    // ======= 추후 확장: 배경 이미지 =======
    // backgroundImagePath, // 예: resolveAssetPath("background.png")
    // backgroundMode = "cover", // cover/contain 등 전략(추후)
    // ====================================

    // (선택) fontconfig를 직접 세팅하고 싶을 때 사용
    // fontConfigDir, // 예: path.resolve("data/assets/fontconfig")
    // fontConfigFile, // 예: path.resolve("data/assets/fontconfig/fonts.conf")
  } = args;

  const outPath = path.join(outDir, `title_${index}.mp4`);

  // 1) 기존 파일 확인
  if (existsSync(outPath)) {
    const st = await fs.stat(outPath);
    if (st.size > 0) {
      console.log(`[${slotID}] ⏩ 타이틀 카드 #${index} 스킵 (이미 존재)`);
      return outPath;
    }
  }

  console.log(`[${slotID}] 🎨 타이틀 카드 #${index} 생성 시작: "${caption}"`);

  // 2) 리소스 존재 여부
  const hasSig = signatureImagePath && existsSync(signatureImagePath);
  const hasTitleFont = titleFontPath && existsSync(titleFontPath);

  if (!hasSig) console.warn(`[${slotID}] ⚠️ 시그니처 이미지 없음 -> 시그니처 오버레이 생략`);
  if (!hasTitleFont) console.warn(`[${slotID}] ⚠️ 폰트 파일 없음 -> 시스템 폰트(Arial 등)로 폴백`);

  // 3) drawtext용 텍스트는 textfile 방식으로 처리(따옴표/특수문자 이슈 회피)
  //    - 파일 인코딩: UTF-8
  //    - 파일 경로: outDir 내부에 생성(디버깅에도 유리)
  await fs.mkdir(outDir, { recursive: true });
  const textFileAbs = path.join(outDir, `title_${index}.txt`);
  const mainText = `${index}. ${caption ?? ""}`; // 여기엔 apostrophe(')가 들어가도 안전(파일로 들어가니까)
  await fs.writeFile(textFileAbs, mainText, { encoding: "utf8" });

  // filter 내부에서 안전하게 쓸 경로(가능하면 상대경로로 만들어 C: 문제 회피)
  const textFileForFilter = fixPathForFfmpegFilter(textFileAbs, { preferRelative: true });

  // 4) 폰트 옵션(가능하면 상대경로)
  //    - fontfile을 쓰면 커스텀 폰트 적용
  //    - 없으면 font='Arial'로 폴백(환경에 따라 다를 수 있음)
  const fontOpt = hasTitleFont
    ? `fontfile='${fixPathForFfmpegFilter(titleFontPath, { preferRelative: true })}'`
    : `font='Arial'`;

  console.log(`[createTitleCardIfNeeded] titleFont점검: :${fontOpt}`);

  // 5) 입력 구성
  //    현재는 color 소스로 배경 생성
  //    ======= 추후 확장: 배경 이미지로 교체하고 싶다면 =======
  //    - backgroundImagePath가 있으면:
  //      -loop 1 -i "<배경이미지>"
  //      그리고 [bg]를 scale/crop 해서 base로 쓰면 됨
  //    =========================================================
  const ffArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "verbose",
    "-stats",
  ];

  // 배경: 검정색
  ffArgs.push("-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`);

  // 오디오: 무음
  ffArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");

  // 시그니처 이미지 입력(있으면 3번째 입력)
  if (hasSig) {
    ffArgs.push("-loop", "1", "-i", path.resolve(signatureImagePath));
  }

  ffArgs.push("-t", String(durationSec));

  // 6) filter_complex 구성
  // 입력 인덱스:
  //  - [0:v] = color 배경
  //  - [1:a] = anullsrc
  //  - [2:v] = signature (있을 때만)
  const filters = [];
  filters.push(`[0:v]format=yuv420p[base0]`);
  let last = "base0";

  if (hasSig) {
    filters.push(`[2:v]scale=${signatureSize}:${signatureSize}[sig]`);
    filters.push(`[${last}][sig]overlay=(W-w)/2:H-h-260:shortest=1[base1]`);
    last = "base1";
  }

  // drawtext: textfile 사용 (가장 안정적)
  // - textfile은 UTF-8 텍스트 파일을 읽어 출력
  // - reload=0(기본) / reload=1로 매 프레임 재로드도 가능(지금은 불필요)
  filters.push(
    `[${last}]drawtext=` +
    `textfile='${textFileForFilter}':` +
    `${fontOpt}:` +
    `fontcolor=white:fontsize=84:expansion=none:` +
    `x=(w-text_w)/2:y=h*0.40` +
    `[base2]`
  );
  last = "base2";

  const filterComplex = filters.join(";");

  // 7) 출력 매핑/코덱
  ffArgs.push("-filter_complex", filterComplex);
  ffArgs.push("-map", `[${last}]`);
  ffArgs.push("-map", "1:a");
  ffArgs.push("-shortest");
  ffArgs.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(fps));
  ffArgs.push("-c:a", "aac", "-ar", "44100", "-ac", "2");
  ffArgs.push(path.resolve(outPath));

  // 디버깅용: 실제 실행 인자 확인(문자열 합치지 않음)
  // console.log(`\n[!!디버깅!!]\n FFMPEG ARGS:\n`, ffArgs, "\n");

  // 8) (선택) fontconfig env 세팅
  //    - 너가 별도 fonts.conf를 만들었다면 아래 env에 넣어서 실행 가능
  //    - 필요 없다면 그대로 process.env 사용
  const env = { ...process.env };
  // if (fontConfigDir) env.FONTCONFIG_PATH = path.resolve(fontConfigDir);
  // if (fontConfigFile) env.FONTCONFIG_FILE = path.resolve(fontConfigFile);
  // if (fontConfigDir) env.FC_CONFIG_DIR = path.resolve(fontConfigDir);

  // 9) 실행
  try {
    await runFfmpeg(ffArgs, { env, cwd: process.cwd() });
    console.log(`[${slotID}] ✅ 타이틀 카드 생성 완료: title_${index}.mp4`);

    // (선택) 텍스트 파일 정리하고 싶으면 주석 해제
    // await fs.unlink(textFileAbs).catch(() => {});

    return outPath;
  } catch (err) {
    console.error(`[${slotID}] ❌ 타이틀 카드 #${index} 생성 실패`);
    if (err?.stderr) {
      console.error(`--- FFmpeg Error Detail ---`);
      console.error(err.stderr);
    } else {
      console.error(err);
    }
    throw err;
  }
}

/* =======================================================================================
 * 4) 병합 + Fade 트랜지션 (ffmpeg filter_complex)
 * ======================================================================================= */

/**
 * [병합] 타이틀+하이라이트를 “페이드”로 자연스럽게 이어붙여 final mp4 생성 (멱등)
 *
 * 왜 concat demuxer(-c copy)가 아닌가?
 * - 입력 파일의 fps/timebase/오디오 구성(채널/샘플레이트)이 조금만 달라도
 *   재생 속도 이상/길이 늘어남/싱크 깨짐 이슈가 쉽게 발생합니다.
 * - filter_complex는 각 세그먼트를 스케일/패딩/오디오 포맷 통일 후 concat하므로 안정성이 높습니다.
 *
 * @param {{
 *   titleCardPaths: string[],
 *   highlightPaths: string[],
 *   outputPath: string,
 *   width?: number,
 *   height?: number,
 *   fps?: number,
 *   durationSec?: number,
 *   highlightSec?: number,
 *   fadeSec?: number,
 *   sampleRate?: number,
 * }} args
 * @returns {Promise<string>}
 */
export async function mergeTitleAndHighlightsWithFade(args) {
  const {
    titleCardPaths,
    highlightPaths,
    outputPath,
    width = 1080,
    height = 1920,
    fps = 30,
    durationSec = 1.2,
    highlightSec = 10,
    fadeSec = 0.15,
    sampleRate = 44100,
    slotID = "UNKNOWN"
  } = args;

  // 1. 사전 검증
  const n = Math.min(titleCardPaths?.length || 0, highlightPaths?.length || 0);
  if (n === 0) {
    console.error(`[${slotID}] 병합할 세그먼트 파일이 없습니다.`);
    throw new Error("no segments");
  }

  console.log(`[${slotID}] 🎬 FFmpeg 병합 프로세스 시작 (세그먼트: ${n}개)`);

  const ordered = [];
  for (let i = 0; i < n; i++) {
    ordered.push(titleCardPaths[i]);
    ordered.push(highlightPaths[i]);
  }

  const inputArgs = ordered.map((p) => `-i "${path.resolve(p)}"`).join(" ");
  const filters = [];

  for (let i = 0; i < ordered.length; i++) {
    const isTitle = i % 2 === 0;
    const dur = isTitle ? durationSec : highlightSec;
    const fadeOutStart = Math.max(0, dur - fadeSec);

    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,` +
      `fade=t=in:st=0:d=${fadeSec},fade=t=out:st=${fadeOutStart}:d=${fadeSec}[v${i}]`
    );

    filters.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,` +
      `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fadeOutStart}:d=${fadeSec}[a${i}]`
    );
  }

  const concatInputs = ordered.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${ordered.length}:v=1:a=1[vout][aout]`);

  const filterComplex = filters.join(";");
  const cmd = `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -r ${fps} -c:a aac -ar ${sampleRate} -ac 2 -b:a 192k "${path.resolve(outputPath)}"`.replace(/\s+/g, " ");

  try {
    console.log(`[${slotID}] FFmpeg 명령 실행 중...`);
    await exec(cmd);
    console.log(`[${slotID}] ✅ FFmpeg 병합 완료: ${path.basename(outputPath)}`);
    return outputPath;
  } catch (err) {
    console.error(`[${slotID}] ❌ FFmpeg 병합 실패!`);
    if (err?.stderr) console.error(`[FFmpeg Error Log]: ${err.stderr.slice(-500)}`);
    throw err;
  }
}