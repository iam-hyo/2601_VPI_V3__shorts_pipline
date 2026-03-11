import { readFullFile, writeFullFile } from '../utils/fs.js';

export class ChannelStorageService {
  constructor(filePath = './data/logs/channelId.csv') {
    this.filePath = filePath;
    this.header = 'channelId,addedCount,latest_slotID';
  }

  async recordChannels(videos, slotID) {
    // 1. 기존 데이터 로드 (Map 구조를 사용하여 검색 속도 O(1) 확보)
    const channelMap = this._loadExistingData();

    // 2. 새로운 데이터 반영
    for (const video of videos) {
      const { channelId } = video;
      if (channelMap.has(channelId)) {
        const data = channelMap.get(channelId);
        data.addedCount = parseInt(data.addedCount) + 1;
        data.latest_slotID = slotID;
      } else {
        channelMap.set(channelId, {
          addedCount: 1,
          latest_slotID: slotID
        });
      }
    }

    // 3. 다시 CSV로 변환하여 저장
    this._saveData(channelMap);
  }

  _loadExistingData() {
    const content = readFullFile(this.filePath);
    const map = new Map();
    if (!content) return map;

    const lines = content.trim().split('\n');
    // 헤더 제외하고 데이터 파싱
    for (let i = 1; i < lines.length; i++) {
      const [id, count, slot] = lines[i].split(',');
      map.set(id, { addedCount: count, latest_slotID: slot });
    }
    return map;
  }

  _saveData(map) {
    let output = this.header + '\n';
    for (const [id, data] of map.entries()) {
      output += `${id},${data.addedCount},${data.latest_slotID}\n`;
    }
    writeFullFile(this.filePath, output);
  }
}