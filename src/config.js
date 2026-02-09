/**
 * [파일 책임]
 * - 프로젝트 전역 설정(지역/임계값/경로/재시도)을 중앙에서 관리합니다.
 *
 * [간단 설명]
 * - 오케스트레이터/러너/서비스들이 이 파일의 상수/함수를 참조합니다.
 */

import path from "node:path";

/**
 * [함수 책임] 환경 변수 로딩/기본값 적용
 * @returns {object} env 설정 객체
 */
export function loadEnv() {
  return {
    NODE_ENV: process.env.NODE_ENV || "production",
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    DATA_DIR: process.env.DATA_DIR || "./data",

    TREND_API_BASE_URL: process.env.TREND_API_BASE_URL || "http://localhost:9001",

    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || "",

    VPI_PREDICTOR_BASE_URL: (process.env.VPI_PREDICTOR_BASE_URL || "").replace(/\/$/, ""),
    VPI_PREDICTOR_ENDPOINT: process.env.VPI_PREDICTOR_ENDPOINT || "/predict/pred7",

    VIDEO_PROCESSOR_API_BASE_URL: (process.env.VIDEO_PROCESSOR_API_BASE_URL || "http://localhost:9002").replace(/\/$/, ""),

    GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-1.5-pro"
  };
}

   
// "필수 인자: --region KR --keyword '...' (옵션: --date YYYY-MM-DD)"
export const REGIONS = ["KR", "US", "MX"];
// export const REGIONS = ["KR", "US"];

/**
 * [상수 책임] 국가별 생성할 영상 개수(슬롯 수)
 */
export const VIDEOS_PER_REGION = 2; //임시로 하나로 테스트.

/** 
 * [하이라이트 초]
 **/
export const HIGHLIGHT_SECOND = 10;
/**
 * [상수 책임] 검증 기준(네 요구사항 반영)
 */
export const VALIDATION = {
  recentDays: 5,
  minShortsCount: 4,
  maxShortsSec: 80,

  // predicted_7day_views >= 50k 영상이 4개 이상
  minPredictedViews: 30_000,
  minQualifiedVideos: 4,
  topK: 4
};

/**
 * [상수 책임] 재시도 정책
 */
export const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000
};

/**
 * [함수 책임] 데이터 경로 규칙 생성
 * @param {string} dataDir
 * @returns {{root:string,runsDir:string,workDir:string,logsDir:string,assetsDir:string}}
 */
export function getDataPaths(dataDir) {
  const abs = path.resolve(dataDir);
  return {
    root: abs,
    runsDir: path.join(abs, "runs"),
    workDir: path.join(abs, "work"),
    logsDir: path.join(abs, "logs"),
    assetsDir: path.join(abs, "assets")
  };
}
