import path from "path";
import { fileURLToPath } from "url";
import fs from "node:fs/promises";
import { ensureDir} from "../video/videoEdit.service_Demo.js";

const __filename = fileURLToPath(import.meta.url); // 현재 실행 중인 이 파일의 전체 절대 경로
const __dirname = path.dirname(__filename); //현재 파일이 들어있는 폴더(디렉토리)의 경로를 가져옵니다.

// video-processor-service 루트 기준
export const SERVICE_ROOT = path.resolve(__dirname, "../../..");
export const ASSETS_DIR = path.join(SERVICE_ROOT, "data", "assets");

export function resolveAssetPath(rel) {
  return path.join(ASSETS_DIR, rel);
}

/**
 * [함수 책임] JSON 원자적 저장(중간 실패로 파일 깨짐 방지)
 * @param {string} filePath
 * @param {any} data
 */
export async function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

export async function readJsonSafe(p) {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}