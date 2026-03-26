"""
extensions/collector.py
외부 API 온디맨드 수집 — TTL 캐시 연동, 데이터 규모 판단, 직접주입/RAG 분기
"""

import json
import logging
from typing import Optional

import httpx

from core.cache import get_cached, set_cached
from core.database import get_external_api

logger = logging.getLogger(__name__)

# 직접 주입 vs RAG 분기 임계값 (토큰 수 기준)
DIRECT_INJECT_TOKEN_LIMIT = 2000


def _estimate_tokens(text: str) -> int:
    korean = sum(1 for c in text if '\uAC00' <= c <= '\uD7A3')
    other  = len(text) - korean
    return int(korean / 1.5 + other / 4)


async def fetch_api_data(
    api_id: int,
    query_params: Optional[dict] = None,
) -> dict:
    """
    외부 API 온디맨드 수집.
    Returns:
        {
          "data": str,          # 응답 텍스트
          "mode": "inject"|"rag",  # 주입 방식
          "cached": bool,
        }
    """
    query_params = query_params or {}
    rec = get_external_api(api_id)
    if not rec:
        raise ValueError(f"API 없음: {api_id}")

    # 1. 캐시 확인
    cached = get_cached(api_id, query_params)
    if cached:
        logger.info("캐시 HIT [api_id=%d]", api_id)
        mode = "inject" if _estimate_tokens(cached) <= DIRECT_INJECT_TOKEN_LIMIT else "rag"
        return {"data": cached, "mode": mode, "cached": True}

    # 2. 외부 API 요청
    headers = {}
    if rec.get("auth_header"):
        headers["Authorization"] = rec["auth_header"]

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(rec["endpoint"], params=query_params, headers=headers)
        resp.raise_for_status()
        raw_text = resp.text

    # 3. TTL 캐시 저장
    set_cached(api_id, query_params, raw_text, rec["ttl_seconds"])
    logger.info("API 수집 완료 [api_id=%d] %d자", api_id, len(raw_text))

    # 4. 데이터 규모 판단
    tokens = _estimate_tokens(raw_text)
    mode   = "inject" if tokens <= DIRECT_INJECT_TOKEN_LIMIT else "rag"

    return {"data": raw_text, "mode": mode, "cached": False}


async def collect_and_prepare(
    api_id: int,
    query_params: Optional[dict] = None,
    config: Optional[dict] = None,
) -> dict:
    """
    수집 후 모드에 따라 처리:
    - inject: 텍스트 그대로 반환 (LLM 컨텍스트 직접 주입용)
    - rag: 임베딩 → 벡터 저장 (검색 가능 상태로 준비)
    """
    result = await fetch_api_data(api_id, query_params)

    if result["mode"] == "rag" and not result["cached"]:
        # 대용량 데이터 → 임베딩 파이프라인
        try:
            from core.file_engine import chunk_text, embed_chunks
            from core.database import add_file_link, add_chunks, add_vectors, update_file_link_status

            rec = get_external_api(api_id)
            cfg = config or {}
            rag_cfg = cfg.get("rag", {})

            chunks  = chunk_text(result["data"],
                                 rag_cfg.get("chunk_size", 512),
                                 rag_cfg.get("chunk_overlap", 64))
            vectors = embed_chunks(chunks)

            # 임시 file_link 레코드로 관리
            fl = add_file_link(
                original_path=f"api://{api_id}",
                display_name=f"API 수집 [id={api_id}]",
                file_type="api",
                embedding_status="done",
            )
            chunk_ids = add_chunks(fl["id"], chunks)
            add_vectors(chunk_ids, vectors)
            logger.info("API 데이터 RAG 저장 완료 [api_id=%d]", api_id)
        except Exception as e:
            logger.error("API RAG 임베딩 실패: %s", e)

    return result
