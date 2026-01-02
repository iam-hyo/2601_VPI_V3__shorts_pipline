/**
 * [파일 책임]
 * - “B 방식” 핵심: videoId -> 허가된 소스 파일 경로로 매핑합니다.
 *
 * [중요]
 * - 이 프로젝트는 YouTube에서 컨텐츠를 다운로드하지 않습니다.
 * - 따라서 YouTube 검색 결과(videoId)를 그대로 “영상 파일”로 사용할 수 없습니다.
 * - 반드시 “허가된 mp4 파일”이 로컬/사내 저장소에 존재해야 하며,
 *   이 resolver가 그 경로를 찾아줘야 합니다.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * [함수 책임]
 * - 기본 구현: data/assets/<videoId>.mp4 를 찾아 반환합니다.
 * - 운영에서는 이 함수를 사내 저장소 검색/다운로드(허가 콘텐츠)로 확장하세요.
 *
 * @param {{assetsDir:string, videoId:string}} args
 * @returns {string} abs file path
 */
export function resolveAuthorizedSourcePath(args) {
  const fp = path.resolve(args.assetsDir, `${args.videoId}.mp4`);
  if (!fs.existsSync(fp)) {
    throw new Error(`허가된 소스 파일이 없습니다: ${fp} (videoId=${args.videoId})`);
  }
  return fp;
}
