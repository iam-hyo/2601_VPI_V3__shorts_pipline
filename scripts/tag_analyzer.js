/**
 * [파일 책임]
 * 특정 키워드에 대해 유튜브가 수집하는 '날것(Raw)'의 태그 데이터를 분석하여
 * CSV 및 JSON으로 저장합니다. 이를 통해 LLM에 들어가는 데이터의 품질을 진단합니다.
 * node scripts/tag_analyzer.js KR 미국
 * 저장위치: ./secripts/debug_tags/KR_미국_1697049600000.{json,csv}
 */

import "dotenv/config";
import { YouTubeClient } from "../src/clients/YouTubeClient.js";
import { loadEnv } from "../src/config.js";
import { writeJsonAtomic } from "../src/utils/fs.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const [,, region, keyword] = process.argv;

  if (!region || !keyword) {
    console.log("Usage: node scripts/tag_analyzer.js <REGION> <KEYWORD>");
    console.log("Example: node scripts/tag_analyzer.js KR 미국");
    process.exit(1);
  }

  const env = loadEnv();
  const yt = new YouTubeClient({ apiKey: env.YOUTUBE_API_KEY });

  console.log(`\n🔍 [${region}] '${keyword}' 태그 수집 및 분석 시작...`);

  // 1. 영상 검색 (최신순 50개)
  const searched = await yt.searchVideos({ q: keyword, maxResults: 50, region, order: 'date' });
  const videoIds = searched.map(v => v.videoId);

  if (videoIds.length === 0) {
    console.error("❌ 검색된 영상이 없습니다.");
    return;
  }

  // 2. 태그 수집
  const tags = await yt.collectHashtags(videoIds);

  // 3. Saturation Penalty 재현 계산 (sigma 12 기준)
  const sigma = 12;
  const analysisData = tags.map(t => {
    const sat_penalty = Math.exp(-(Math.pow(t.TF, 2)) / (2 * Math.pow(sigma, 2)));
    return {
      tag: t.tag,
      f: t.TF,
      sat_penalty: Number(sat_penalty.toFixed(4)),
      is_valid: sat_penalty >= 0.3 ? "YES" : "NO (Saturated)"
    };
  });

  // 4. 결과 저장 경로 설정
  const outputDir = path.join(process.cwd(), "scripts/debug_tags");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  const baseName = `${region}_${keyword.replace(/\s+/g, '_')}_${new Date().getTime()}`;

  // 5. JSON 저장 (LLM 입력 시뮬레이션용)
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  writeJsonAtomic(jsonPath, analysisData);

  // 6. CSV 저장 (엑셀 분석용)
  const csvPath = path.join(outputDir, `${baseName}.csv`);
  const csvHeader = "Tag,Frequency(f),Sat_Penalty,Is_Valid\n";
  const csvRows = analysisData.map(d => `"${d.tag}",${d.f},${d.sat_penalty},${d.is_valid}`).join("\n");
  fs.writeFileSync(csvPath, csvHeader + csvRows, "utf8");

  // 7. 결과 요약 출력
  console.log("\n✅ 분석 완료!");
  console.log(`- 수집된 총 태그 수: ${tags.length}`);
  console.log(`- 저장 위치: ${outputDir}/`);
  console.log(`\n📊 [상위 10개 태그 현황]`);
  console.table(analysisData.slice(0, 10));
}

main().catch(console.error);


/**
 * // 책임: 결과 저장 폴더 생성
  const outputDir = path.join(process.cwd(), "scripts", "searchTest");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 책임: 파일명 생성
  const safeKeyword = keyword.replace(/\s+/g, "_");
  const baseName = `${region}_${safeKeyword}_${Date.now()}`;

  // 책임: CSV 문자열 생성
  const csvHeader = "videoId,title,channelTitle,publishedAt\n";
  const csvRows = searched
    .map((d) =>
      `"${escapeCsv(d.videoId)}","${escapeCsv(d.title)}","${escapeCsv(d.channelTitle)}","${escapeCsv(d.publishedAt)}"`
    )
    .join("\n");

  const csvPath = path.join(outputDir, `${baseName}.csv`);
  fs.writeFileSync(csvPath, csvHeader + csvRows, "utf8");

  console.log(`📁 CSV 저장 완료: ${csvPath}`);
}

main().catch((err) => {
  console.error("❌ 실행 중 오류 발생:");
  console.error(err);
  process.exit(1);
});
 */