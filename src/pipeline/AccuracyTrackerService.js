// src/pipeline/AccuracyTrackerService.js
import Database from 'better-sqlite3';
import path from 'path';

export class AccuracyTrackerService {
  constructor(youtubeClient) {
    this.dbPath = path.resolve(process.cwd(), 'data', 'logs', 'accuracy.db');
    this.db = new Database(this.dbPath); // 파일이 없으면 자동 생성
    this.youtubeClient = youtubeClient; // 7일 뒤 조회수 조회를 위해 주입
    this._initTable();
  }

  // 테이블이 없으면 최초 생성
  _initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        vid_id TEXT PRIMARY KEY,
        ch_id TEXT,
        region TEXT,
        collected_at TEXT,
        when_is_7 TEXT,
        age_hours REAL,
        sub_count INTEGER,
        current_views INTEGER,
        pred_7 INTEGER,
        actual_7 INTEGER,
        ape REAL
      )
    `);
  }

  // [삽입 시점 1] PipelineRunner.js 에서 picked 확정 시 호출
  recordNewPicks(videos, region, collectedAt) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO predictions 
      (vid_id, ch_id, region, collected_at, when_is_7, age_hours, sub_count, current_views, pred_7)
      VALUES (@vid_id, @ch_id, @region, @collected_at, @when_is_7, @age_hours, @sub_count, @current_views, @pred_7)
    `);

    const insertMany = this.db.transaction((vids) => {
      for (const v of vids) {
        // 💡 [핵심 로직 변경] 수집일(collectedAt)이 아닌, 영상의 '실제 공개일(publishedAt)' 기준 + 7일 계산
        let whenIs7Str = 'UNKNOWN';
        if (v.publishedAt) {
          const publishedDate = new Date(v.publishedAt);
          publishedDate.setDate(publishedDate.getDate() + 7);
          whenIs7Str = publishedDate.toISOString().split('T')[0]; // YYYY-MM-DD
        } else {
          console.warn(`[Tracker] ⚠️ ${v.videoId}의 publishedAt이 없습니다. 계산 불가.`);
        }

        insert.run({
          vid_id: v.videoId,
          ch_id: v.channelId || 'UNKNOWN', // ValidationService에서 살려준 데이터 매핑
          region: region,
          collected_at: collectedAt.toISOString(),
          when_is_7: whenIs7Str,           // 영상별 공개일 + 7일로 변경됨
          age_hours: v.ageHours || 0,      // 정상 적재됨
          sub_count: v.subscriberCount || 0, // 정상 적재됨
          current_views: v.viewCount || 0,
          pred_7: v.predicted7d || 0
        });
      }
    });

    insertMany(videos);
    console.log(`[Tracker] 📊 ${videos.length}개의 예측 데이터 DB 저장 완료.`);
  }

  // [삽입 시점 2] Orchestrator.js 에서 매일 파이프라인 실행 전/후 호출
  async evaluatePendingRecords() {
    const todayStr = new Date().toISOString().split('T')[0];

    // 검증 대상 조회: 7일이 도래했고, 아직 실제 조회수가 기록되지 않은 영상
    const pendingStmt = this.db.prepare(`
      SELECT vid_id, pred_7 FROM predictions 
      WHERE when_is_7 <= ? AND actual_7 IS NULL
    `);
    const pendingRecords = pendingStmt.all(todayStr);

    if (pendingRecords.length === 0) return;
    console.log(`[Tracker] 🔍 7일 경과 영상 ${pendingRecords.length}건 정확도 검증 시작...`);

    const updateStmt = this.db.prepare(`
      UPDATE predictions 
      SET actual_7 = @actual, ape = @ape 
      WHERE vid_id = @vid_id
    `);

    for (const record of pendingRecords) {
      try {
        // YouTube API를 통해 최신 조회수 가져오기 (youtubeClient 구현체에 맞게 호출)
        const currentStats = await this.youtubeClient.getVideoStats(record.vid_id);
        const actual7 = currentStats.viewCount;

        // APE (Absolute Percentage Error) 계산: |(실제 - 예측) / 실제| * 100
        // (실제 조회수가 0인 경우 분모 0 에러 방지)
        let ape = 0;
        if (actual7 > 0) {
          ape = Math.abs((actual7 - record.pred_7) / actual7) * 100;
        }

        updateStmt.run({ actual: actual7, ape: ape, vid_id: record.vid_id });
      } catch (err) {
        console.warn(`[Tracker] ⚠️ ${record.vid_id} 검증 실패: ${err.message}`);
      }
    }
    console.log(`[Tracker] ✅ 정확도 검증 및 DB 업데이트 완료.`);
  }

  // 대시보드/리포트 용: 언제든 호출해서 MAPE 확인 가능
  getOverallMAPE() {
    const row = this.db.prepare(`SELECT AVG(ape) as mape, COUNT(*) as count FROM predictions WHERE ape IS NOT NULL`).get();
    return row;
  }
}