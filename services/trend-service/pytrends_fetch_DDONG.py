"""
[파일 책임]
- (기본) pytrends로 '지금 뜨는 국가 전체 트렌딩 검색어'를 JSON으로 반환합니다.
- (옵션) 가능하면 유튜브 검색 기반으로 가져오려 시도할 수 있으나(실험적),
  안정성이 떨어질 수 있어 기본값은 OFF입니다.

[왜 이렇게 설계했나?]
- Google Trends의 "트렌딩 검색어 피드(국가 전체)"는 pytrends에서 비교적 단순하게 가져올 수 있습니다.
- 하지만 "유튜브 검색 한정(gprop='youtube')" + "국가 전체 트렌딩"을 그대로 제공하는 공식/안정 API가 없고,
  pytrends의 build_payload(gprop='youtube')는 '특정 키워드 기반 분석'에 더 맞습니다.
- 그래서 운영 안정성을 위해 기본은 '국가 전체 트렌딩'으로 두고,
  유튜브 기반은 옵션으로만 제공합니다.

입력:
- --region: KR/US/MX
- --days: 출력에 들어갈 days 값(기본 7)  ※ 실시간 트렌딩은 실제로는 "지금" 기준이므로 days는 메타값 성격
- --prefer_youtube: (선택) 유튜브 검색 기반으로 시도 (실험적 / 429 위험 증가 가능)

출력(JSON):
{
  "region": "KR",
  "days": 7,
  "items": [
    {"date":"2026-01-07","keyword":"...", "traffic":""},
    ...
  ],
  "keywords": ["...", "...", ...]
}

오류 처리:
- 실패 시 stderr로 원인 로그 출력 후 exit code 1
- stdout에는 JSON만 출력(성공 시)
"""

import argparse
import json
import sys
from datetime import datetime
from pytrends.request import TrendReq
from pytrends.exceptions import ResponseError


REGION_GEO_MAP = {"KR": "KR", "US": "US", "MX": "MX"}

# pytrends 트렌딩 피드 계열은 보통 pn(예: "south_korea")를 받는 경우가 많아서 별도 매핑
REGION_PN_MAP = {
    "KR": "south_korea",
    "US": "united_states",
    "MX": "mexico",
}


def log(msg: str) -> None:
    """stdout(JSON)을 방해하지 않기 위해 stderr로 로그"""
    print(f"[PYTHON-DEBUG] {msg}", file=sys.stderr, flush=True)


def _safe_extract_keywords_from_df(df):
    """
    [역할]
    - pytrends가 주는 DataFrame은 버전/엔드포인트마다 컬럼 형태가 조금씩 다를 수 있음
    - 여기서는 최대한 방어적으로 '키워드 문자열 리스트'를 뽑는다.
    """
    if df is None or df.empty:
        return []

    cols = list(df.columns)

    # 가장 흔한 형태: 첫 컬럼에 키워드가 있는 단일 컬럼 DF
    # 또는 'title', 'query' 등의 컬럼이 있을 수도 있어 후보를 순서대로 확인
    candidate_cols = []
    for c in ["query", "title", "keyword"]:
        if c in cols:
            candidate_cols.append(c)
    if cols:
        candidate_cols.append(cols[0])  # 마지막으로 첫 컬럼을 fallback

    out = []
    for _, row in df.iterrows():
        kw = None
        for c in candidate_cols:
            try:
                v = row.get(c)
            except Exception:
                v = None
            if v:
                kw = str(v).strip()
                if kw:
                    break
        if kw:
            out.append(kw)

    # 중복 제거(순서 유지)
    seen = set()
    uniq = []
    for k in out:
        if k not in seen:
            uniq.append(k)
            seen.add(k)
    return uniq


def fetch_trending_keywords(pytrends: TrendReq, pn: str):
    """
    [역할]
    - 가장 안정적인 순서로 "국가 전체 트렌딩 키워드"를 시도한다.
    - realtime_trending_searches -> trending_searches -> daily_search_trends(오늘) 폴백
    """
    # 1) 실시간 트렌드(가장 원하는 "지금 뜨는" 성격)
    try:
        log(f"시도: realtime_trending_searches(pn={pn})")
        df = pytrends.realtime_trending_searches(pn=pn)
        kws = _safe_extract_keywords_from_df(df)
        if kws:
            log(f"성공: realtime_trending_searches 키워드 {len(kws)}개")
            return kws, "realtime_trending_searches"
        log("realtime_trending_searches 결과가 비어 있음")
    except Exception as e:
        log(f"realtime_trending_searches 실패: {repr(e)}")

    # 2) 일간 트렌드(오늘 기준 트렌드)
    try:
        log(f"시도: trending_searches(pn={pn})")
        df = pytrends.trending_searches(pn=pn)
        kws = _safe_extract_keywords_from_df(df)
        if kws:
            log(f"성공: trending_searches 키워드 {len(kws)}개")
            return kws, "trending_searches"
        log("trending_searches 결과가 비어 있음")
    except Exception as e:
        log(f"trending_searches 실패: {repr(e)}")

    # 3) 마지막 폴백: daily_search_trends(오늘)
    # (버전에 따라 date 인자 형태가 다를 수 있어 예외 처리)
    today_str = datetime.now().strftime("%Y-%m-%d")
    try:
        log(f"시도: daily_search_trends(pn={pn}, date={today_str})")
        df = pytrends.daily_search_trends(pn=pn, date=today_str)
        kws = _safe_extract_keywords_from_df(df)
        if kws:
            log(f"성공: daily_search_trends 키워드 {len(kws)}개")
            return kws, "daily_search_trends"
        log("daily_search_trends 결과가 비어 있음")
    except Exception as e:
        log(f"daily_search_trends 실패: {repr(e)}")

    return [], "none"


def fetch_youtube_like_keywords_experimental(pytrends: TrendReq, geo: str, days: int):
    """
    [실험적/옵션]
    - "유튜브 검색(gprop=youtube)" 조건은 build_payload 기반 분석에만 자연스럽게 적용됨
    - 이 방식은 '국가 전체 트렌딩 피드'가 아니라, 특정 seed 키워드의 "급상승 연관검색어"를 이용하는 근사치임.
    - 사용자는 '유튜브 관련 키워드 편향'을 원하지 않는다고 했으니 기본 OFF 권장.
    """
    timeframe = f"now {days}-d"
    seed = "youtube"  # 최소한의 seed. 다만 편향 발생 가능.

    log(f"[실험] 유튜브 근사치 시도: build_payload(seed={seed}, geo={geo}, timeframe={timeframe}, gprop=youtube)")
    pytrends.build_payload(kw_list=[seed], cat=0, timeframe=timeframe, geo=geo, gprop="youtube")
    rq = pytrends.related_queries()
    rising_df = rq.get(seed, {}).get("rising")

    if rising_df is None or rising_df.empty:
        return []

    kws = []
    for _, row in rising_df.iterrows():
        q = row.get("query")
        if q:
            kws.append(str(q).strip())

    # 중복 제거
    seen = set()
    uniq = []
    for k in kws:
        if k and k not in seen:
            uniq.append(k)
            seen.add(k)

    log(f"[실험] 유튜브 근사치 키워드 {len(uniq)}개")
    return uniq


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True, choices=["KR", "US", "MX"])
    parser.add_argument("--days", default="7")
    parser.add_argument("--prefer_youtube", action="store_true")  # 기본 False
    args = parser.parse_args()

    days = int(args.days)
    result = {"region": args.region, "days": days, "items": [], "keywords": []}

    geo = REGION_GEO_MAP.get(args.region, "KR")
    pn = REGION_PN_MAP.get(args.region, "south_korea")
    today_str = datetime.now().strftime("%Y-%m-%d")

    log(f"데이터 수집 시작: region={args.region}, geo={geo}, pn={pn}, days={days}, prefer_youtube={args.prefer_youtube}")

    try:
        pytrends = TrendReq(
            hl="ko-KR",
            tz=540,
            retries=2,
            backoff_factor=0.3,
            timeout=(10, 30),
        )

        keywords = []
        source = "none"

        # 1) (옵션) 유튜브 근사치를 먼저 시도
        if args.prefer_youtube:
            try:
                keywords = fetch_youtube_like_keywords_experimental(pytrends, geo=geo, days=days)
                source = "youtube_experimental_related_queries"
            except ResponseError as e:
                # 429 같은 케이스가 여기에 많이 걸릴 수 있음
                log(f"[실험] ResponseError: {str(e)}")
                keywords = []
            except Exception as e:
                log(f"[실험] 예외: {repr(e)}")
                keywords = []

        # 2) 유튜브 옵션이 꺼져있거나(기본), 실패했으면 "국가 전체 트렌딩"으로 간다.
        if not keywords:
            keywords, source = fetch_trending_keywords(pytrends, pn=pn)

        # 결과 구성(traffic은 트렌딩 피드에서 안정적으로 제공되지 않는 경우가 많아 빈값 유지)
        for kw in keywords:
            item = {"date": today_str, "keyword": kw, "traffic": ""}
            result["items"].append(item)
            result["keywords"].append(kw)

        log(f"수집 완료: source={source}, items={len(result['items'])}")

    except Exception as e:
        # 오케스트레이터가 재시도 판단할 수 있도록 에러를 명확히 전달
        log(f"치명적 오류 발생: {str(e)}")
        sys.exit(1)

    # stdout에는 JSON만
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
