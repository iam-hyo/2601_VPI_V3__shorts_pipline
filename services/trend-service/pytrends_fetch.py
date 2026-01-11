"""
[파일 책임]
- pytrends를 통해 '최근 N일' 트렌드 후보를 수집해 JSON으로 반환합니다.

[간단 설명]
- Google Trends는 공식 API가 아니므로 환경/차단/지역에 따라 실패할 수 있습니다.
- 본 스크립트는 실패 시에도 서비스가 죽지 않도록 빈 결과를 반환합니다.

입력:
- --region: KR/US/MX
- --days: 최근 며칠치(기본 7)

출력(JSON):
{
  "region": "KR",
  "days": 7,
  "items": [
    {"date":"2026-01-01","keyword":"...", "traffic":"200K+"},
    ...
  ]
}
"""

import argparse
import json
import sys
from datetime import datetime
from pytrends.request import TrendReq

REGION_GEO_MAP = {
    "KR": "KR",
    "US": "US",
    "MX": "MX",
}
def log(msg):
    """표준 에러(stderr)로 로그를 출력하여 JSON 출력을 방해하지 않음"""
    print(f"[PYTHON-DEBUG] {msg}", file=sys.stderr)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True, choices=["KR", "US", "MX"])
    parser.add_argument("--days", default="7")
    args = parser.parse_args()

    # Node.js에서 기대하는 키값인 'keywords'와 'items'를 모두 포함하여 하위 호환성 유지
    result = {"region": args.region, "days": int(args.days), "items": [], "keywords": []}
    
    geo = REGION_GEO_MAP.get(args.region, "KR")
    timeframe = f"now {args.days}-d" # 'now 7-d'

    log(f"데이터 수집 시작: 지역={geo}, 기간={timeframe}, 플랫폼=YouTube")

    try:
        # 1. TrendReq 설정 (hl: 언어, tz: 시차)
        # 구글 차단을 피하기 위해 timeout과 retries 설정 추가
        pytrends = TrendReq(
            hl='ko-KR',
            tz=540,
            retries=2,
            backoff_factor=0.3,
            timeout=(10, 30),
        )
        # 2. 페이로드 구축 (키워드 없이 지역/기간/유튜브 검색 필터 적용)
        # 쿼리 파라미터 구축. kw_list: 검색어 목록, 시간대, 지역, 플랫폼
        pytrends.build_payload(kw_list=[''], cat=0, timeframe=timeframe, geo=geo, gprop='youtube')

        # 3. 관련 검색어(Related Queries) 가져오기
        related_queries = pytrends.related_queries()
        
        # 키워드 없이 호출하면 결과 사전의 키는 ''(빈 문자열)입니다.
        rising_data = related_queries.get('', {}).get('rising')

        if rising_data is not None and not rising_data.empty:
            log(f"급상승 키워드 {len(rising_data)}개 발견")
            
            for _, row in rising_data.iterrows():
                keyword = row['query']
                # 'breakout'은 보통 5000% 이상 상승을 의미함
                value = row['value']
                
                item = {
                    "date": datetime.now().strftime("%Y-%m-%d"),
                    "keyword": keyword,
                    "traffic": str(value) # 'breakout' 또는 숫자
                }
                result["items"].append(item)
                result["keywords"].append(item) # Node.js에서 keywords를 쓰므로 중복 제공
        else:
            log("급상승 데이터가 존재하지 않거나 가져오지 못했습니다.")

    except Exception as e:
        log(f"치명적 오류 발생: {str(e)}")
        # 중요: 빈 값을 출력하는 대신 에러 상태로 종료하여 상위 호출자가 알게 함
        sys.exit(1)

    # 최종 결과 출력 (오직 JSON만 stdout으로 출력)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()