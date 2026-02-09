import os
import math
import argparse
import pandas as pd
from datetime import datetime
from collections import Counter
from dotenv import load_dotenv
from googleapiclient.discovery import build

# 1. 환경 변수 및 설정
load_dotenv()
API_KEY = os.getenv("YOUTUBE_API_KEY")
YOUTUBE_SERVICE_NAME = "youtube"
YOUTUBE_API_VERSION = "v3"

def get_tag_analysis(region, keyword):
    # 폴더 생성 로직
    output_dir = "result"
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"Directory created: {output_dir}")

    # 유튜브 API 빌드
    youtube = build(YOUTUBE_SERVICE_NAME, YOUTUBE_API_VERSION, developerKey=API_KEY)

    print(f">>> '{keyword}' ({region}) 검색 및 분석 시작...")

    # 2. 검색 (최대 50개 영상 ID 추출)
    search_response = youtube.search().list(
        q=keyword,
        part="id",
        maxResults=50,
        type="video",
        regionCode=region
    ).execute()

    video_ids = [item['id']['videoId'] for item in search_response.get('items', [])]
    
    if not video_ids:
        print("검색 결과가 없습니다.")
        return

    # 3. 영상 상세 정보(Tags) 추출
    video_response = youtube.videos().list(
        part="snippet",
        id=",".join(video_ids)
    ).execute()

    all_tags = []
    video_tags_list = []

    for item in video_response.get('items', []):
        tags = item['snippet'].get('tags', [])
        all_tags.extend(tags)
        video_tags_list.append(tags)

    # 4. TF-IDF 기반 점수 계산
    total_docs = len(video_tags_list)
    tf_counts = Counter(all_tags)
    
    analysis_results = []
    for tag in set(all_tags):
        tf = tf_counts[tag]
        df_t = sum(1 for tags in video_tags_list if tag in tags)
        
        # TF-IDF 수식 (log10 사용)
        idf = math.log10(total_docs / df_t)
        tfidf_score = tf * idf

        analysis_results.append({
            "태그": tag,
            "TF": tf,
            "df(t)": df_t,
            "TF-IDF점수": round(tfidf_score, 4)
        })

    # 5. 데이터프레임 생성 및 정렬
    df_result = pd.DataFrame(analysis_results)
    if not df_result.empty:
        df_result = df_result.sort_values(by="TF-IDF점수", ascending=False)

    # 6. 파일 저장 (날짜_region_keyword.csv)
    date_str = datetime.now().strftime("%Y%m%d")
    safe_keyword = keyword.replace(" ", "_")
    file_name = f"{date_str}_{region}_{safe_keyword}.csv"
    file_path = os.path.join(output_dir, file_name)
    
    df_result.to_csv(file_path, index=False, encoding='utf-8-sig')
    
    print("-" * 30)
    print(f"분석 완료!")
    print(f"저장 경로: {file_path}")
    print(f"추출된 태그 수: {len(df_result)}")
    print("-" * 30)
    
    return df_result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="YouTube Tag Analyzer for VPI Project")
    parser.add_argument("--region", type=str, default="KR", help="Region code (default: KR)")
    parser.add_argument("--keyword", type=str, required=True, help="Search keyword")

    args = parser.parse_args()
    get_tag_analysis(args.region, args.keyword)