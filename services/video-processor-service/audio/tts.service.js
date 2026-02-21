// .\services\video-processor-service\audio\tts.service.js
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const exec = promisify(execCb);

/**
 * [TTS 서비스] 텍스트를 음성 파일로 변환
 */
export async function generateTtsFiles(titleInfos, region, outDir) {
  // 언어별 목소리 매핑 (비즈니스 로직)
  const voiceMap = {
    'KR': 'ko-KR-SunHiNeural',
    'US': 'en-US-ChristopherNeural',
    'MX': 'es-MX-DaliaNeural'
  };
  
  const voice = voiceMap[region] || voiceMap['US'];
  const ttsPaths = [];

  for (const info of titleInfos) {
    const ttsPath = path.resolve(path.join(outDir, `tts_${info.index}.mp3`));
    
    // 텍스트에서 특수문자 제거 (CLI 명령어 오류 방지)
    const cleanText = info.caption.replace(/["']/g, ""); 
    
    const cmd = `edge-tts --voice ${voice} --text "${cleanText}" --write-media "${ttsPath}"`;
    
    try {
      await exec(cmd);
      ttsPaths.push(ttsPath);
    } catch (err) {
      console.error(`[TTS Error] #${info.index} 생성 실패:`, err.message);
      // TTS 실패가 영상 제작 전체의 중단으로 이어지지 않게 하려면 
      // 여기서 에러를 던지지 않고 더미 오디오를 넣는 식의 처리가 가능합니다.
    }
  }

  return ttsPaths;
}