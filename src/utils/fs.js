/**
 * [파일 책임]
 * - 파일/폴더 유틸(원자적 JSON 저장 포함)
 */

import { file } from "googleapis/build/src/apis/file";
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

// ------------------- csv 로깅 ----------------------------
/**
 * CSV 형식으로 데이터를 누적 기록하는 함수 (Upsert 로직은 상위에서 처리)
 * @param {string} filePath 파일 경로
 * @param {string} header 헤더 (파일이 없을 때만 사용)
 * @param {string} row 데이터 한 줄
 */
export const appendToCsv = (filePath, header, row) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const isNew = !fs.existsSync(filePath); //있는 건지 확인
  const stream = fs.createWriteStream(filePath, { flags: 'a' }); //a는 append의 약자
  if (isNew) {
    stream.write(header + '\n');
  }
  stream.write(row + '\n');
  stream.end();
};

/**
 * 전체 파일을 읽어오는 함수 (기존 데이터 업데이트 시 필요)
 */
export const readFullFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
};

/**
 * 파일 내용을 완전히 덮어쓰는 함수 (Upsert 완료 후 저장용)
 */
export const writeFullFile = (filePath, content) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};