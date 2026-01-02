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
import { exec as _exec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(_exec);

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
  return String(text ?? "")
    .replace(/\\/g, "\\\\")   // 1) 백슬래시 탈출
    .replace(/'/g, "'\\''")   // 2) 싱글쿼트 탈출
    .replace(/:/g, "\\:");    // 3) 콜론 탈출
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
export async function downloadVideoIfNeeded({ videoId, outDir }) {
  await ensureDir(outDir);
  const outPath = path.join(outDir, `${videoId}.mp4`);

  // 1) 이미 파일이 있으면 스킵
  if (await exists(outPath)) {
    console.log(`[videoEdit.demo] download skip (exists): ${outPath}`);
    return outPath;
  }

  // 2) 다운로드 명령어 구성
  // -f mp4: MP4 포맷을 우선 선택(편집 호환성)
  // -o: 출력 경로 지정
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const cmd = `yt-dlp -f mp4 -o "${outPath}" "${url}"`;

  console.log(`[videoEdit.demo] 다운로드중..: ${videoId} (시간이 소요될 수 있습니다)`);
  await exec(cmd);
  return outPath;
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
  if (await exists(outputPath)) {
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
export async function createTitleCardIfNeeded({
  outDir,
  index,
  caption,
  subCaption = "",
  durationSec = 1.2,
  width = 1080,
  height = 1920,
  fps = 30,

  // 1) 시그니처 이미지(프로필)
  signatureImagePath = path.join(process.cwd(), "data", "assets", "5토끼_유튜브 프로필.png"),
  signatureSize = 220,

  // 2) 서브타이틀 폰트
  subtitleFontPath = path.join(process.cwd(), "data", "assets", "memomentKkukkkuk.ttf"),

  // (선택) 메인 타이틀 폰트(없으면 시스템 폰트 사용)
  titleFontPath = process.env.FFMPEG_TITLE_FONT_PATH || "",
}) {
  await ensureDir(outDir);

  const outPath = path.join(outDir, `title_${index}.mp4`);
  if (await exists(outPath)) {
    console.log(`[videoEdit.demo] title card skip (exists): ${outPath}`);
    return outPath;
  }

  // 텍스트 escape
  const mainText = escapeForDrawtext(`${index}. ${caption || ""}`);
  const subText = escapeForDrawtext(subCaption || "");

  // 폰트 파일이 실제로 없으면 FFmpeg가 실패할 수 있습니다.
  // - 그래서 존재할 때만 fontfile 옵션을 넣습니다.
  const titleFontOpt = titleFontPath && existsSync(titleFontPath)
    ? `:fontfile='${normalizeFontPath(titleFontPath)}'`
    : "";

  const subtitleFontOpt = subtitleFontPath && existsSync(subtitleFontPath)
    ? `:fontfile='${normalizeFontPath(subtitleFontPath)}'`
    : "";

  // 시그니처 이미지가 없으면 overlay는 스킵합니다.
  const hasSig = !!signatureImagePath && existsSync(signatureImagePath);

  // -------------------------------------------------------------------------------------
  // (추후) 배경이미지 삽입을 위한 예시 (비율 맞춰 준비한 이미지를 넣는 것을 권장)
  // const bgImagePath = path.join(process.cwd(), "data", "assets", "title_bg.png");
  // const hasBg = existsSync(bgImagePath);
  //
  // if (hasBg) {
  //   // 입력을 하나 더 받도록 설계하고 filter_complex에서 [bg]로 스케일/크롭 후 base로 사용
  //   // 예: `-loop 1 -i "${bgImagePath}"` 추가
  // }
  // -------------------------------------------------------------------------------------

  // ffmpeg 입력 구성:
  // 0) 검은 배경(color)
  // 1) 무음 오디오(anullsrc) -> merge 단계에서 오디오 일관성 유지에 도움
  // 2) (옵션) 시그니처 이미지(루프)
  const inputParts = [
    `-f lavfi -i "color=c=black:s=${width}x${height}:r=${fps}"`,
    `-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100"`,
  ];

  if (hasSig) {
    inputParts.push(`-loop 1 -i "${signatureImagePath}"`);
  }

  // filter_complex 구성
  // 1) base 영상 준비
  // 2) 시그니처 이미지 overlay (있을 때만)
  // 3) 메인 타이틀 drawtext
  // 4) 서브 타이틀 drawtext (memoment 폰트)
  //
  // y 위치는 “중앙 + 하단 시그니처”를 동시에 고려해 적당히 배치했습니다.
  const filters = [];

  // base
  filters.push(`[0:v]format=yuv420p[base0]`);

  let last = "base0";
  if (hasSig) {
    // 시그니처를 정사각으로 스케일
    filters.push(`[2:v]scale=${signatureSize}:${signatureSize}[sig]`);

    // 중앙 하단부: 아래에서 220px 위(여백 포함) 정도로 배치
    // y=h-overlay_h-260: '260'은 여백(안전 영역)입니다.
    filters.push(`[${last}][sig]overlay=(W-w)/2:H-h-260:shortest=1[base1]`);
    last = "base1";
  }

  // drawtext: 메인 타이틀
  filters.push(
    `[${last}]drawtext=text='${mainText}'${titleFontOpt}:` +
    `fontcolor=white:fontsize=84:` +
    `x=(w-text_w)/2:y=h*0.40[base2]`
  );
  last = "base2";

  // drawtext: 서브타이틀 (폰트 적용)
  if (subText) {
    filters.push(
      `[${last}]drawtext=text='${subText}'${subtitleFontOpt}:` +
      `fontcolor=white:fontsize=56:` +
      `x=(w-text_w)/2:y=h*0.52[base3]`
    );
    last = "base3";
  }

  const filterComplex = filters.join(";");

  const cmd = `
ffmpeg -y \
${inputParts.join(" ")} \
-t ${durationSec} \
-filter_complex "${filterComplex}" \
-map "[${last}]" -map 1:a \
-shortest \
-c:v libx264 -pix_fmt yuv420p -r ${fps} \
-c:a aac -ar 44100 -ac 2 \
"${outPath}"
  `.trim().replace(/\s+/g, " ");

  console.log(`[videoEdit.demo] create title card: ${path.basename(outPath)}`);

  try {
    await exec(cmd);
    return outPath;
  } catch (err) {
    console.error(`\n❌ 타이틀 카드 생성 실패!`);
    console.error(`caption: ${caption}`);
    if (err?.stderr) console.error(err.stderr);
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
export async function mergeTitleAndHighlightsWithFade({
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
}) {
  if (await exists(outputPath)) {
    console.log(`[videoEdit.demo] merge skip (exists): ${outputPath}`);
    return outputPath;
  }

  const n = Math.min(titleCardPaths?.length || 0, highlightPaths?.length || 0);
  if (n === 0) throw new Error("mergeTitleAndHighlightsWithFade: no segments");

  // (title, highlight, title, highlight, ...)
  const ordered = [];
  for (let i = 0; i < n; i++) {
    ordered.push(titleCardPaths[i]);
    ordered.push(highlightPaths[i]);
  }

  // 경로는 반드시 절대경로로 넣는게 안정적입니다.
  const inputArgs = ordered.map((p) => `-i "${path.resolve(p)}"`).join(" ");

  const filters = [];
  for (let i = 0; i < ordered.length; i++) {
    const isTitle = i % 2 === 0;
    const dur = isTitle ? durationSec : highlightSec;
    const fadeOutStart = Math.max(0, dur - fadeSec);

    // 비디오: 해상도/비율 통일 + 페이드 in/out
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1,` + // 픽셀 비율 고정(왜곡 방지)
        `fps=${fps},format=yuv420p,` +
        `fade=t=in:st=0:d=${fadeSec},` +
        `fade=t=out:st=${fadeOutStart}:d=${fadeSec}[v${i}]`
    );

    // 오디오: 포맷/샘플레이트/채널 통일 + 페이드 in/out
    filters.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,` +
        `afade=t=in:st=0:d=${fadeSec},` +
        `afade=t=out:st=${fadeOutStart}:d=${fadeSec}[a${i}]`
    );
  }

  const concatInputs = ordered.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${ordered.length}:v=1:a=1[vout][aout]`);

  const filterComplex = filters.join(";");

  const cmd = `
ffmpeg -y ${inputArgs} \
-filter_complex "${filterComplex}" \
-map "[vout]" -map "[aout]" \
-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -r ${fps} \
-c:a aac -ar ${sampleRate} -ac 2 -b:a 192k \
"${path.resolve(outputPath)}"
  `.trim().replace(/\s+/g, " ");

  console.log(`[videoEdit.demo] merge start: ${path.basename(outputPath)}`);

  try {
    await exec(cmd);
    return outputPath;
  } catch (err) {
    console.error(`\n❌ FFmpeg 병합 실패!`);
    console.error(`명령어(일부): ${cmd.substring(0, 220)}...`);
    if (err?.stderr) {
      console.error(`--- FFmpeg Error Details ---`);
      console.error(err.stderr);
      console.error(`-----------------------------`);
    }
    throw err;
  }
}
