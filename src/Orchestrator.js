/**
 * [파일 책임]
 * - 오케스트레이터는 “실행 순서”만 한 눈에 보이도록 최소 로직만 유지합니다.
 * - Resume/상태관리/검증/서비스 호출은 PipelineRunner로 위임합니다.
 */

import "dotenv/config";
import { loadEnv, getDataPaths, REGIONS, VIDEOS_PER_REGION } from "./config.js";
import { ensureDir } from "./utils/fs.js";
import { createLogger } from "./utils/logger.js";
import { RunStateStore } from "./orchestrator/RunStateStore.js";
import { PipelineRunner } from "./pipeline/PipelineRunner.js";

const log = createLogger("Orchestrator");

/**
 * [함수 책임] 오늘 날짜를 YYYY-MM-DD로 생성합니다.
 * @param {Date} d
 * @returns {string}
 */
function yyyy_mm_dd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const env = loadEnv();
  const paths = getDataPaths(env.DATA_DIR);

  ensureDir(paths.runsDir);
  ensureDir(paths.workDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.assetsDir);

  const runId = yyyy_mm_dd(new Date());
  const store = new RunStateStore(paths.runsDir);
  const runner = new PipelineRunner({ env, paths, store });

  log.info({ runId }, "=== DAILY PIPELINE START ===");

  // ✅ 실행 순서만 남김 (가독성 최우선)
  for (const region of REGIONS) {
    // console.log(`${region} 수집 시작`)
    await runner.runRegionKeword(region, runId);

    for (let slot = 1; slot <= VIDEOS_PER_REGION; slot += 1) {
      await runner.runVideoSlot(region, runId, slot);
    }
  }

  runner.finishRun(runId, REGIONS);

  log.info({ runId }, "=== DAILY PIPELINE DONE ===");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
