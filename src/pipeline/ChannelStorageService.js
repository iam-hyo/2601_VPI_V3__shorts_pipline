import path from 'path';
import { readFullFile, writeFullFile } from '../utils/fs.js';

export class ChannelStorageService {
  constructor(fileName = 'channelId.csv') {
    // 💡 핵심 1: 프로젝트 최상단 기준 절대 경로 고정 (실행 위치가 달라도 항상 같은 파일 참조)
    this.filePath = path.resolve(process.cwd(), 'data', 'logs', fileName);
    this.header = 'channelId,addedCount,latest_slotID,region';
  }

  async recordChannels(videos, slotID, region) {
    // 1. 기존 데이터 로드
    const channelMap = this._loadExistingData();

    // 2. 새로운 데이터 반영
    let newCount = 0;
    for (const video of videos) {
      // 실제 데이터 구조에 맞게 channelId 추출 (디버깅 하신 키값으로 교체하세요!)
      const channelId = video.channelId || video.snippet?.channelId || video.channel_id;

      if (!channelId) continue; // 방어

      if (channelMap.has(channelId)) {
        const data = channelMap.get(channelId);
        data.addedCount = parseInt(data.addedCount, 10) + 1; // 문자열 덧셈 방지
        data.latest_slotID = slotID;
        data.region = region;
      } else {
        channelMap.set(channelId, {
          addedCount: 1,
          latest_slotID: slotID,
          region: region
        });
        newCount++;
      }
    }

    // 3. 다시 CSV로 저장
    this._saveData(channelMap);
    console.log(`[ChannelStorage] 💾 업데이트 완료! (총 ${channelMap.size}개 중 ${newCount}개 신규 추가)`);
  }

  _loadExistingData() {
    const content = readFullFile(this.filePath);
    const map = new Map();

    // 💡 핵심 2: 파일을 찾지 못했을 때 정확히 로그를 남겨 원인 파악
    if (!content) {
      console.warn(`[ChannelStorage] ⚠️ 기존 파일을 찾을 수 없거나 비어있습니다. 새로 생성합니다: ${this.filePath}`);
      return map;
    }

    const lines = content.trim().split('\n');
    let loadCount = 0;
    
    // 헤더(0번 인덱스) 제외하고 루프
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue; // 빈 줄 무시
      
      const [id, count, slot, reg] = lines[i].split(',');
      if (id && id !== 'undefined') {
        // 숫자 연산을 위해 count를 확실히 숫자로 파싱해 둡니다
        map.set(id, { 
          addedCount: parseInt(count, 10) || 1, 
          latest_slotID: slot, 
          region: reg || 'UNKNOWN' 
        });
        loadCount++;
      }
    }
    
    console.log(`[ChannelStorage] 📂 기존 채널 데이터 ${loadCount}건 로드 완료. (${this.filePath})`);
    return map;
  }

  _saveData(map) {
    let output = this.header + '\n';
    for (const [id, data] of map.entries()) {
      output += `${id},${data.addedCount},${data.latest_slotID},${data.region}\n`;
    }
    writeFullFile(this.filePath, output);
  }
}