/**
 * src/Orchestrator.js
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
 * @param {Date}
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
  const store = new RunStateStore(paths.runsDir); // runId를 인자로 받아 관리하는 class
  const runner = new PipelineRunner({ env, paths, store }); // Resume/상태관리/재시도/서비스 호출을 담당하는 클래스

  log.info({ runId }, "=== DAILY PIPELINE을 시작합니다. ===");

  // ✅ 실행 순서만 남김 (가독성 최우선)
  for (const region of REGIONS) {
    await runner.runRegionKeword(region, runId); // 산출물로 region의 트랜드 데이터 저장. 순위 필터링 로직 필요.

    for (let slot =1; slot <= VIDEOS_PER_REGION; slot += 1) { // 반복이 끝나면 slot을 1 증가시킴.
      await runner.runVideoSlot(region, runId, slot);
    }
  }

  runner.finishRun(runId, REGIONS);

  log.info({ runId }, "=== DAILY PIPELINE이 종료되었습니다. ===");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
