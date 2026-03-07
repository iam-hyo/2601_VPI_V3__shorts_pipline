/** 
 * ./scripts/searchTest/searchTest.js
 * 유튜브 search api를 테스트.
 * 
 * 1. env에서 api연결
 * 2. 입력 스펙: 키워드, 국가, 
 * 3. 기타 스펙: order: "date", 50개, 최근 5일 이내, 비디오, 쇼츠
 * 4. 출력 결과: ./scripts/searchTest에 csv로 결과 저장, 콘솔로 검색결과 출력
 * 5. 실행 예시 node scripts/searchTest/searchTest.js KR "천궁 2"
*/

import "dotenv/config";
import { YouTubeClient } from "../../src/clients/YouTubeClient.js";
import { loadEnv } from "../../src/config.js";
import fs from "node:fs";
import path from "node:path";

/**
 * [함수 책임] CSV에서 큰따옴표를 안전하게 처리
 * @param {string | undefined | null} value
 * @returns {string}
 */
function escapeCsv(value) {
  return String(value ?? "").replace(/"/g, '""');
}

async function main() {
    const [, , region, keyword] = process.argv;

    if (!region || !keyword) {
        console.log("Usage: node scripts/searchTest.js <REGION> <KEYWORD>");
        console.log("Example: node scripts/searchTest.js KR 천궁2");
        process.exit(1);
    }

    const env = loadEnv();
    const yt = new YouTubeClient({ apiKey: env.YOUTUBE_API_KEY });

    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()

    console.log(`\n🔍 [${region}] '${keyword}' 태그 수집 및 분석 시작...`);

    // 1. 영상 검색 (최신순 50개)
    const searched = await yt.searchVideos({ q: keyword, maxResults: 50, region, publishedAfterISO: fiveDaysAgo });
    const videoIds = searched.map(v => v.videoId);

    if (videoIds.length === 0) {
        console.error("❌ 검색된 영상이 없습니다.");
        return;
    }

    // 책임: 콘솔 출력
    console.log(`✅ 검색 결과 ${searched.length}개\n`);
    searched.forEach((v, idx) => {
        console.log(
            `${idx + 1}. [${v.publishedAt}] ${v.title}\n` +
            `   - channel: ${v.channelTitle}\n` +
            `   - videoId: ${v.videoId}\n`
        );
    });

    const outputDir = path.join(process.cwd(), "scripts", "searchTest");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, {recursive: true});
    const baseName = `${region}_${keyword.replace(/\s+/g, '_')}_${Date.now()}`;

    // 6. CSV 저장 (엑셀 분석용)
    const csvHeader = "videoId,title,channelTitle,publishedAt\n";
    const csvRows = searched.map(d => `"${d.videoId}",${escapeCsv(d.title)},${escapeCsv(d.channelTitle)},${escapeCsv(d.publishedAt)}`).join("\n");
    const csvPath = path.join(outputDir, `${baseName}.csv`);
    
    fs.writeFileSync(csvPath, csvHeader + csvRows, "utf8");
    console.log(`📁 CSV 저장 완료: ${csvPath}`);
}

main().catch((err) => {
  console.error("❌ 실행 중 오류 발생:");
  console.error(err);
  process.exit(1);
});