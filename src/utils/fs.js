/**
 * [파일 책임]
 * - 파일/폴더 유틸(원자적 JSON 저장 포함)
 */

import fs from "node:fs";
import path from "node:path";

/**
 * [함수 책임] 디렉토리 생성(없으면 생성)
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * [함수 책임] JSON 원자적 저장(중간 실패로 파일 깨짐 방지)
 * @param {string} filePath
 * @param {any} data
 */
export function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

/**
 * [함수 책임] 파일이 있으면 JSON 로드, 없으면 undefined
 * @template T
 * @param {string} filePath
 * @returns {T|undefined}
 */
export function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
