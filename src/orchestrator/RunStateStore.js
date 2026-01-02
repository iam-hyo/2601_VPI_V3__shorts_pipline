/**
 * [파일 책임]
 * - RunID 상태파일(runs/*.json)의 생성/로드/저장을 담당합니다.
 * - Resume(이어하기)는 이 파일의 상태를 기준으로 동작합니다.
 */

import path from "node:path";
import { ensureDir, readJsonIfExists, writeJsonAtomic } from "../utils/fs.js";
import { REGIONS, VIDEOS_PER_REGION } from "../config.js";

/**
 * [함수 책임] 기본 RunState 생성
 * @param {string} runId
 * @returns {object} RunState
 */
function createDefaultRunState(runId) {
  const now = new Date().toISOString();

  const regions = {};
  for (const r of REGIONS) {
    regions[r] = {
      region: r,
      trends: { status: "PENDING" },
      videos: Array.from({ length: VIDEOS_PER_REGION }, (_, i) => ({
        slot: i + 1,
        status: "PENDING"
      })),
      status: "PENDING"
    };
  }

  return {
    runId,
    date: runId,
    createdAt: now,
    updatedAt: now,
    status: "PENDING",
    regions
  };
}

export class RunStateStore {
  /**
   * [생성자 책임] runsDir 경로를 받아 폴더를 준비합니다.
   * @param {string} runsDir
   */
  constructor(runsDir) {
    this.runsDir = runsDir;
    ensureDir(this.runsDir);
  }

  /**
   * [메서드 책임] 상태 파일 경로 계산
   * @param {string} runId
   * @returns {string}
   */
  filePath(runId) {
    return path.join(this.runsDir, `${runId}.json`);
  }

  /**
   * [메서드 책임] runId 상태를 로드하거나, 없으면 생성합니다.
   * @param {string} runId
   * @returns {object} RunState
   */
  loadOrCreate(runId) {
    const fp = this.filePath(runId);
    const existing = readJsonIfExists(fp);
    if (existing) return existing;

    const created = createDefaultRunState(runId);
    writeJsonAtomic(fp, created);
    return created;
  }

  /**
   * [메서드 책임] RunState를 저장(원자적)합니다.
   * @param {object} state
   */
  save(state) {
    const fp = this.filePath(state.runId);
    writeJsonAtomic(fp, { ...state, updatedAt: new Date().toISOString() });
  }
}
