import textToSpeech from '@google-cloud/text-to-speech';
import fs from 'fs';
import path from 'path';

// GCP 클라이언트 초기화 (.env의 GOOGLE_APPLICATION_CREDENTIALS를 자동 인식함)
const client = new textToSpeech.TextToSpeechClient();

// ============================================================================
// 💡 [GCP 인증 확인용 로그] - 파이프라인 실행 시 콘솔에서 확인하세요!
client.getProjectId()
  .then(projectId => console.log(`[GCP Auth] ✅ Google Cloud TTS 인증 완벽 연결됨! (프로젝트: ${projectId})`))
  .catch(err => console.error(`[GCP Auth] ❌ 인증 실패. CLI 로그인을 확인하세요.`, err.message));
// ============================================================================

const VOICE_MAP = {
  'KR': { languageCode: 'ko-KR', name: 'ko-KR-Neural2-B' },
  'US': { languageCode: 'en-US', name: 'en-US-Wavenet-I' },
  'MX': { languageCode: 'es-ES', name: 'es-ES-Chirp3-HD-Orus' },
};

/**
 * [CORE] 범용 오디오 합성 엔진 (통신 및 파일 IO 전담)
 */
async function synthesizeAudio(content, region, outPath, isSsml = false) {
  const voiceSelection = VOICE_MAP[region] || VOICE_MAP['US'];

  const request = {
    input: isSsml ? { ssml: content } : { text: content },
    voice: voiceSelection,
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.1 // 쇼츠의 템포에 맞춘 1.1배속
    },
  };

  try {
    const [response] = await client.synthesizeSpeech(request);
    await fs.promises.writeFile(outPath, response.audioContent, 'binary');
    return outPath;
  } catch (error) {
    console.error(`[GCP TTS Error] 오디오 생성 실패 (${outPath}):`, error.message);
    throw error;
  }
}

/**
 * [WRAPPER 1] 통합 인트로 오디오 생성
 */
export async function generateIntroTts(originalKeyword, region, outDir) {
  const translations = {
    'KR': "이번주엔 이 클립이 뜰 꺼라고?",
    'US': "Viral this week?",
    'MX': "¿Viral esta semana?",
  };
  const subText = translations[region] || translations['US'];

  // SSML 호흡 연출 (키워드 강조 후 0.25초 쉬기)
  const ssmlContent = `
    <speak>
      <prosody rate="1.35" pitch="+1.5st">
        ${originalKeyword}! <break time="150ms"/> ${subText}
      </prosody>
    </speak>
  `;
  const outPath = path.resolve(path.join(outDir, `intro_audio.mp3`));
  return await synthesizeAudio(ssmlContent, region, outPath, true);
}

/**
 * [WRAPPER 2] 본문 자막 오디오 생성 (기존 로직 일반화)
 */
export async function generateTtsFiles(titleInfos, region, outDir) {
  const ttsPaths = [];

  for (const info of titleInfos) {
    const outPath = path.resolve(path.join(outDir, `tts_${info.index}.mp3`));
    const cleanText = info.caption.replace(/["']/g, "");

    try {
      await synthesizeAudio(cleanText, region, outPath, false);
      ttsPaths.push(outPath);
    } catch (err) {
      console.error(`[TTS Error] #${info.index} 생성 실패, 무시하고 진행합니다.`);
    }
  }

  return ttsPaths;
}