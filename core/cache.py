"""
core/cache.py
SQLite TTL 캐시 — 외부 API 온디맨드 응답 저장/조회
"""

import hashlib
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)


def _hash_key(api_id: int, params: dict) -> str:
    raw = json.dumps({"api_id": api_id, "params": params}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def get_cached(api_id: int, params: dict) -> Optional[str]:
    """TTL 캐시 조회. 만료됐거나 없으면 None."""
    from core.database import get_connection
    key = _hash_key(api_id, params)
    conn = get_connection()
    try:
        row = conn.execute("""
            SELECT response_data FROM api_cache
            WHERE api_id=? AND query_hash=? AND expires_at > datetime('now','localtime')
        """, (api_id, key)).fetchone()
        return row["response_data"] if row else None
    finally:
        conn.close()


def set_cached(api_id: int, params: dict, data: str, ttl_seconds: int) -> None:
    """응답 캐시 저장."""
    from core.database import get_connection
    key     = _hash_key(api_id, params)
    expires = (datetime.now() + timedelta(seconds=ttl_seconds)).isoformat()
    conn = get_connection()
    try:
        conn.execute("""
            INSERT INTO api_cache(api_id, query_hash, response_data, expires_at)
            VALUES(?,?,?,?)
            ON CONFLICT(api_id, query_hash) DO UPDATE
            SET response_data=excluded.response_data, expires_at=excluded.expires_at
        """, (api_id, key, data, expires))
        conn.commit()
    except Exception as e:
        logger.warning("캐시 저장 실패: %s", e)
    finally:
        conn.close()


def cleanup_expired() -> int:
    """만료된 캐시 삭제. 삭제 건수 반환."""
    from core.database import get_connection
    conn = get_connection()
    try:
        cur = conn.execute(
            "DELETE FROM api_cache WHERE expires_at <= datetime('now','localtime')"
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()
