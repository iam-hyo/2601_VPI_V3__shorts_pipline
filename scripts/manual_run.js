/** 
 * ./scripts/manualrun.js
 * - 수동 실행(Sub-Orchestrator) CLI
 *
 * 사용 예:
 * node scripts/manual_run.js --region KR --keyword "My Topic" --date 2026-01-02
 */

import "dotenv/config";
import { loadEnv, getDataPaths } from "../src/config.js";
import { ensureDir } from "../src/utils/fs.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import { PipelineRunner } from "../src/pipeline/PipelineRunner.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--")) continue;
    out[k.slice(2)] = v;
  }
  return out;
}

function yyyy_mm_dd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const region = args.region;
  const keyword = args.keyword;
  const date = args.date || yyyy_mm_dd(new Date());

  if (!region || !keyword) {
    // eslint-disable-next-line no-console
    console.error("필수 인자: --region KR --keyword '...' (옵션: --date YYYY-MM-DD)");
    process.exit(2);
  }

  const env = loadEnv();
  const paths = getDataPaths(env.DATA_DIR);

  ensureDir(paths.runsDir);
  ensureDir(paths.workDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.assetsDir);

  const store = new RunStateStore(paths.runsDir);
  const runner = new PipelineRunner({ env, paths, store });

  const runId = await runner.runManualOne({ region, keyword, date });

  // eslint-disable-next-line no-console
  console.log(`[${keyword}}] 영상제작 완료 runId=${runId}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
