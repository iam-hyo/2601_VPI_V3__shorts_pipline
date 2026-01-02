# Auto Daily Shorts Pipeline (JS / API-Oriented) - KR, US, MX

> ⚠️ 정책/저작권 안내(중요)  
> 이 프로젝트는 **오케스트레이션 + 상태관리 + API 분리 프레임워크**입니다.  
> 타인의 유튜브 영상을 무단으로 다운로드/편집/재업로드하는 자동화는 저작권/플랫폼 정책 위반 소지가 큽니다.  
> 따라서 본 레포는 **“허가된(licensed/owned) 소스”** 를 전제로 하며, **YouTube 다운로드(ytdlp 등) 자동화는 포함하지 않습니다.**  
> 대신 `SourceResolver`를 통해 **허가된 로컬 파일 경로/사내 저장소 URL** 로 매핑하도록 설계했습니다.

---

## 0) 무엇이 “완성”되어 있나?
- ✅ Orchestrator는 **최소 로직**(실행 순서만)으로 구성
- ✅ Trend / Video Processor는 **HTTP API로 호출** (분산 구조)
- ✅ RunID 상태파일(`data/runs/*.json`) 기반으로 **자동 기록/Resume**
- ✅ VPI Predictor API: 네가 준 스펙으로 **배치 요청** 구현
- ✅ Gemini: `GEMINI_API_KEY_1..N` 키 로테이션(토큰/쿼터 소진 시 자동 전환)
- ✅ “수동 실행” Sub-Orchestrator 제공 (`scripts/manual_run.js`)

---

## 1) 전체 구조
### 실행(오케스트레이터)
- `src/Orchestrator.js`
  - 국가(KR/US/MX) → 슬롯(1~2) 순서만 호출
  - 나머지 로직(Resume/검증/서비스 호출/업로드)은 `PipelineRunner`로 위임

### 서비스(API)
- Trend Service (실제 구현)
  - `services/trend-service/server.js`
  - `GET /trends/daily?region=KR&days=7`
  - 내부에서 pytrends로 후보 수집 → Gemini로 필터링/우선순위 → keywords 반환
- Video Processor Service (B 방식)
  - `services/video-processor-service/server.js`
  - `POST /process`
  - Request:
    ```json
    {
      "workDir": "...",
      "topic": "keyword",
      "sources": [
        {"id":"XoSoSmthMb4","inputPath":"/abs/path/to/XoSoSmthMb4.mp4"},
        {"id":"...","inputPath":"/abs/path/to/....mp4"}
      ]
    }
    ```
  - 서버는 `inputPath`를 이용해 하이라이트/타이틀카드/병합해서 `outputs/final.mp4` 생성 후 반환

### 핵심 플러그인(허가 소스 매핑)
- `src/source/SourceResolver.js`
  - YouTube 검색/예측으로 뽑힌 `videoId`를 **허가된 소스 파일 경로로 매핑**
  - 기본은 `data/assets/<videoId>.mp4`를 찾도록 구현 (없으면 에러)

---

## 2) 설치 & 실행(로컬 테스트)
### 2-1) Node 설치
- Node.js 18+ (20+ 권장)

### 2-2) 의존성 설치
```bash
npm install
cp .env.example .env
```

### 2-3) Python(pytrends) 설치(Trend Service용)
```bash
pip3 install -r services/trend-service/requirements.txt
```

### 2-4) 서비스 실행(별도 터미널 2개)
```bash
# 터미널 A: Trend Service
node services/trend-service/server.js

# 터미널 B: Video Processor Service
node services/video-processor-service/server.js
```

### 2-5) 오케스트레이터 실행
```bash
node src/Orchestrator.js 
// npm rum daily
```

---

## 3) 수동 실행(Sub-Orchestrator)
트렌드 없이 “내가 입력한 keyword + region + date”로 1개의 영상을 생성합니다.
```bash
node scripts/manual_run.js --region KR --keyword "My Topic" --date 2026-01-02
```

- 생성 결과는 `data/work/<date>__MANUAL__.../` 아래에 저장됩니다.
- 상태파일은 `data/runs/<runId>.json` 으로 기록됩니다.

---

## 4) 반드시 수정/설정해야 하는 것들(가정사항)
1) **YouTube Data API Key**
- `.env`의 `YOUTUBE_API_KEY` 필요 (검색/메타/통계 수집에 사용)

2) **허가 소스 준비(중요)**
- 오케스트레이터는 YouTube에서 고른 `videoId`를 그대로 “컨텐츠 파일”로 쓰지 않습니다.
- `SourceResolver`가 `videoId -> 허가된 로컬 mp4 파일`로 매핑해야 합니다.
- 기본 구현은: `data/assets/<videoId>.mp4` 를 찾습니다.
  - 예: `data/assets/XoSoSmthMb4.mp4`

3) **VPI Predictor API URL**
- `.env`의 `VPI_PREDICTOR_BASE_URL`, `VPI_PREDICTOR_ENDPOINT` 설정
- 인증 헤더 없음(요구사항 반영)

4) **Gemini API Key 로테이션**
- `.env`에 `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, ... 추가 가능

5) (옵션) YouTube 업로드
- 업로드는 OAuth2 Refresh Token 필요
- `.env`의 `YOUTUBE_OAUTH_*` 채우면 업로드 활성화, 없으면 자동 SKIP

---

## 5) 디버깅/로깅 팁
- `data/runs/YYYY-MM-DD.json`을 보면 **어디까지 DONE**인지 바로 확인 가능
- `data/work/.../meta.json`에 선정된 키워드, 선정된 videoId가 남습니다.
- Trend Service 로그에는 days(몇 일치), traffic(검색량) 등 디버깅 정보를 기록합니다.

---

## 6) 다음 고도화(추천)
- YouTube API Quota 추적/차단 로직
- Predictor 결과 캐싱(영상별 7일 예측은 반복 호출될 수 있음)
- SourceResolver를 “사내 저장소 검색/다운로드(허가 콘텐츠)”로 확장
