"""
core/database.py
SQLite 초기화 및 전체 테이블 관리
FTS5 전문 검색 + sqlite-vec 벡터 DB + 파일 링크 레지스트리 + API 캐시
"""

import sqlite3
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DB_PATH = Path("storage/db/vanilla.db")


def get_connection() -> sqlite3.Connection:
    """DB 커넥션 반환. Row를 dict처럼 접근 가능하게 설정."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # 동시 읽기 성능 향상
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """앱 시작 시 1회 실행. 존재하지 않는 테이블만 생성 (멱등)."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = get_connection()
    try:
        _create_tables(conn)
        _create_fts_tables(conn)
        _try_load_sqlite_vec(conn)
        conn.commit()
        logger.info("DB 초기화 완료: %s", DB_PATH)
    finally:
        conn.close()


# ──────────────────────────────────────────
# 테이블 생성
# ──────────────────────────────────────────

def _create_tables(conn: sqlite3.Connection) -> None:

    # 채팅 세션
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT    DEFAULT '새 대화',
            is_favorite INTEGER DEFAULT 0,      -- 0: 일반 / 1: 즐겨찾기
            created_at  DATETIME DEFAULT (datetime('now','localtime')),
            updated_at  DATETIME DEFAULT (datetime('now','localtime'))
        )
    """)

    # 채팅 메시지
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role       TEXT    NOT NULL CHECK(role IN ('user','assistant','system')),
            content    TEXT    NOT NULL,
            created_at DATETIME DEFAULT (datetime('now','localtime'))
        )
    """)

    # 파일 링크 레지스트리 (원본 복사 없이 경로 참조)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS file_links (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            original_path    TEXT    NOT NULL,
            display_name     TEXT,
            file_type        TEXT,              -- pdf / image / docx / txt 등
            embedding_status TEXT    DEFAULT 'pending',  -- pending / running / done / error
            embedding_model  TEXT,             -- 임베딩에 사용된 모델명 (차원 불일치 감지용)
            registered_at    DATETIME DEFAULT (datetime('now','localtime')),
            last_verified_at DATETIME,
            status           TEXT    DEFAULT 'OK'  -- OK / BROKEN / MOVED
        )
    """)

    # 문서 청크 (임베딩 전 텍스트 단위)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id     INTEGER NOT NULL REFERENCES file_links(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            content     TEXT    NOT NULL,
            created_at  DATETIME DEFAULT (datetime('now','localtime'))
        )
    """)

    # 외부 API 등록 목록
    conn.execute("""
        CREATE TABLE IF NOT EXISTS external_apis (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            endpoint    TEXT NOT NULL,
            ttl_seconds INTEGER DEFAULT 3600,
            auth_header TEXT,                  -- 선택적 인증 헤더 (e.g. "Bearer token")
            created_at  DATETIME DEFAULT (datetime('now','localtime')),
            updated_at  DATETIME DEFAULT (datetime('now','localtime'))
        )
    """)

    # 외부 API 응답 TTL 캐시
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_cache (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            api_id        INTEGER NOT NULL REFERENCES external_apis(id) ON DELETE CASCADE,
            query_hash    TEXT    NOT NULL,
            response_data TEXT    NOT NULL,
            created_at    DATETIME DEFAULT (datetime('now','localtime')),
            expires_at    DATETIME NOT NULL,
            UNIQUE(api_id, query_hash)
        )
    """)

    # 앱 상태 저장 (Greeting 조건, 기타 영속 상태)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS app_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    # 인덱스
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_favorite ON sessions(is_favorite DESC, updated_at DESC)")


def _create_fts_tables(conn: sqlite3.Connection) -> None:
    """FTS5 전문 검색 가상 테이블 생성."""

    # 채팅 메시지 전문 검색
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages
        USING fts5(content, session_id UNINDEXED, message_id UNINDEXED)
    """)

    # 문서 청크 전문 검색
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks
        USING fts5(content, file_id UNINDEXED, chunk_id UNINDEXED)
    """)


def _try_load_sqlite_vec(conn: sqlite3.Connection) -> None:
    """sqlite-vec 확장 로드 시도. 없으면 경고만 출력."""
    try:
        import sqlite_vec
        sqlite_vec.load(conn)
        logger.info("sqlite-vec 확장 로드 성공")
    except Exception as e:
        logger.warning("sqlite-vec 로드 실패 (벡터 검색 비활성화): %s", e)


# ──────────────────────────────────────────
# app_state 헬퍼
# ──────────────────────────────────────────

def get_state(key: str) -> Optional[str]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM app_state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None
    finally:
        conn.close()


def set_state(key: str, value: str) -> None:
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO app_state(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value)
        )
        conn.commit()
    finally:
        conn.close()


# ──────────────────────────────────────────
# 세션 CRUD
# ──────────────────────────────────────────

def create_session(title: str = "새 대화") -> dict:
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO sessions(title) VALUES(?) RETURNING *", (title,)
        )
        row = cur.fetchone()
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def get_sessions() -> list[dict]:
    """즐겨찾기 상단 고정, 최근 수정순 정렬."""
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT * FROM sessions
            ORDER BY is_favorite DESC, updated_at DESC
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_session(session_id: int) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_session(session_id: int, **kwargs) -> Optional[dict]:
    """title, is_favorite 등 부분 업데이트."""
    allowed = {"title", "is_favorite"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return None

    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [session_id]

    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE sessions SET {set_clause}, updated_at=datetime('now','localtime') WHERE id=?",
            values
        )
        conn.commit()
        return get_session(session_id)
    finally:
        conn.close()


def delete_sessions(session_ids: list[int]) -> int:
    """복수 세션 삭제. 삭제된 수 반환."""
    conn = get_connection()
    try:
        placeholders = ",".join("?" * len(session_ids))
        cur = conn.execute(
            f"DELETE FROM sessions WHERE id IN ({placeholders})", session_ids
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


# ──────────────────────────────────────────
# 메시지 CRUD
# ──────────────────────────────────────────

def add_message(session_id: int, role: str, content: str) -> dict:
    conn = get_connection()
    try:
        # FTS5 동기화
        cur = conn.execute(
            "INSERT INTO messages(session_id, role, content) VALUES(?,?,?) RETURNING *",
            (session_id, role, content)
        )
        row = cur.fetchone()
        msg_id = row["id"]

        # FTS 인덱스 업데이트 (user/assistant 메시지만)
        if role in ("user", "assistant"):
            conn.execute(
                "INSERT INTO fts_messages(content, session_id, message_id) VALUES(?,?,?)",
                (content, session_id, msg_id)
            )

        # 세션 updated_at 갱신
        conn.execute(
            "UPDATE sessions SET updated_at=datetime('now','localtime') WHERE id=?",
            (session_id,)
        )
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def get_messages(session_id: int) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id=? ORDER BY id ASC",
            (session_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_message_count(session_id: int) -> int:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM messages WHERE session_id=?", (session_id,)
        ).fetchone()
        return row["cnt"] if row else 0
    finally:
        conn.close()

# ──────────────────────────────────────────
# file_links CRUD
# ──────────────────────────────────────────

def add_file_link(
    original_path: str,
    display_name: Optional[str],
    file_type: str,
    embedding_status: str = "pending",
) -> dict:
    conn = get_connection()
    try:
        cur = conn.execute("""
            INSERT INTO file_links(original_path, display_name, file_type, embedding_status)
            VALUES(?,?,?,?) RETURNING *
        """, (original_path, display_name, file_type, embedding_status))
        row = cur.fetchone()
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def get_all_file_links() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM file_links ORDER BY registered_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_file_link(file_id: int) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM file_links WHERE id=?", (file_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_file_link_status(
    file_id: int,
    status: Optional[str] = None,
    embedding_status: Optional[str] = None,
    embedding_model: Optional[str] = None,
    last_verified_at: Optional[str] = None,
) -> None:
    fields, values = [], []
    if status is not None:
        fields.append("status=?"); values.append(status)
    if embedding_status is not None:
        fields.append("embedding_status=?"); values.append(embedding_status)
    if embedding_model is not None:
        fields.append("embedding_model=?"); values.append(embedding_model)
    if last_verified_at is not None:
        fields.append("last_verified_at=?"); values.append(last_verified_at)
    if not fields:
        return
    values.append(file_id)
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE file_links SET {', '.join(fields)} WHERE id=?", values
        )
        conn.commit()
    finally:
        conn.close()


def delete_file_link(file_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM file_links WHERE id=?", (file_id,))
        conn.commit()
    finally:
        conn.close()


# ──────────────────────────────────────────
# 청크 + 벡터 저장 (3-2)
# ──────────────────────────────────────────

def add_chunks(file_id: int, chunks: list[str]) -> list[int]:
    """청크 텍스트 저장 + FTS5 인덱스. 청크 ID 리스트 반환."""
    conn = get_connection()
    try:
        ids = []
        for idx, content in enumerate(chunks):
            cur = conn.execute(
                "INSERT INTO chunks(file_id, chunk_index, content) VALUES(?,?,?) RETURNING id",
                (file_id, idx, content)
            )
            chunk_id = cur.fetchone()[0]
            ids.append(chunk_id)
            # FTS5 인덱스
            conn.execute(
                "INSERT INTO fts_chunks(content, file_id, chunk_id) VALUES(?,?,?)",
                (content, file_id, chunk_id)
            )
        conn.commit()
        return ids
    finally:
        conn.close()


def add_vectors(chunk_ids: list[int], vectors: list[list[float]]) -> None:
    """sqlite-vec에 벡터 저장. chunk_id를 rowid로 사용."""
    conn = get_connection()
    try:
        import sqlite_vec, struct
        sqlite_vec.load(conn)
        # vec_chunks 가상 테이블이 없으면 생성 (첫 실행 시)
        if vectors:
            dim = len(vectors[0])
            conn.execute(f"""
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
                USING vec0(embedding float[{dim}])
            """)
            for chunk_id, vec in zip(chunk_ids, vectors):
                blob = struct.pack(f"{len(vec)}f", *vec)
                conn.execute(
                    "INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES(?,?)",
                    (chunk_id, blob)
                )
        conn.commit()
    except Exception as e:
        logger.warning("벡터 저장 실패 (sqlite-vec 미설치?): %s", e)
    finally:
        conn.close()


# ──────────────────────────────────────────
# 하이브리드 검색 + RRF (3-3)
# ──────────────────────────────────────────

def fts_search_chunks(query: str, top_k: int = 20) -> list[dict]:
    """FTS5 키워드 검색."""
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT c.id, c.file_id, c.content,
                   rank AS fts_score
            FROM fts_chunks f
            JOIN chunks c ON c.id = f.chunk_id
            WHERE fts_chunks MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (query, top_k)).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("FTS5 검색 오류: %s", e)
        return []
    finally:
        conn.close()


def vec_search_chunks(query_vec: list[float], top_k: int = 20) -> list[dict]:
    """sqlite-vec Dense 벡터 검색."""
    conn = get_connection()
    try:
        import sqlite_vec, struct
        sqlite_vec.load(conn)
        blob = struct.pack(f"{len(query_vec)}f", *query_vec)
        rows = conn.execute("""
            SELECT v.rowid AS id, v.distance,
                   c.file_id, c.content
            FROM vec_chunks v
            JOIN chunks c ON c.id = v.rowid
            WHERE embedding MATCH ?
              AND k = ?
            ORDER BY distance
        """, (blob, top_k)).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("벡터 검색 오류 (sqlite-vec 미설치?): %s", e)
        return []
    finally:
        conn.close()


def rrf_merge(
    fts_results: list[dict],
    vec_results: list[dict],
    top_k: int = 5,
    k: int = 60,
) -> list[dict]:
    """
    Reciprocal Rank Fusion — FTS5 + 벡터 결과 병합.
    RRF score = 1/(k + rank_fts) + 1/(k + rank_vec)
    """
    scores: dict[int, float] = {}
    id_to_doc: dict[int, dict] = {}

    for rank, doc in enumerate(fts_results):
        cid = doc["id"]
        scores[cid] = scores.get(cid, 0) + 1 / (k + rank + 1)
        id_to_doc[cid] = doc

    for rank, doc in enumerate(vec_results):
        cid = doc["id"]
        scores[cid] = scores.get(cid, 0) + 1 / (k + rank + 1)
        id_to_doc[cid] = doc

    sorted_ids = sorted(scores, key=lambda x: scores[x], reverse=True)
    return [id_to_doc[cid] for cid in sorted_ids[:top_k]]


def hybrid_search(
    query: str,
    query_vec: Optional[list[float]],
    top_k: int = 5,
) -> list[dict]:
    """FTS5 + 벡터 하이브리드 검색 → RRF 병합."""
    fts = fts_search_chunks(query, top_k=20)
    vec = vec_search_chunks(query_vec, top_k=20) if query_vec else []
    merged = rrf_merge(fts, vec, top_k=top_k)
    # 파일 정보 보강
    conn = get_connection()
    try:
        for doc in merged:
            fl = conn.execute(
                "SELECT display_name, original_path FROM file_links WHERE id=?",
                (doc.get("file_id"),)
            ).fetchone()
            if fl:
                doc["source_name"] = fl["display_name"]
                doc["source_path"] = fl["original_path"]
    finally:
        conn.close()
    return merged


# ──────────────────────────────────────────
# 통합 검색 (채팅 + 파일) — Phase 5용
# ──────────────────────────────────────────

def search_sessions(query: str, top_k: int = 20) -> list[dict]:
    """FTS5로 채팅 메시지 검색."""
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT s.id as session_id, s.title, s.updated_at,
                   f.content as snippet
            FROM fts_messages f
            JOIN sessions s ON s.id = f.session_id
            WHERE fts_messages MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (query, top_k)).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("메시지 검색 오류: %s", e)
        return []
    finally:
        conn.close()


def search_files(query: str, top_k: int = 20) -> list[dict]:
    """파일명 + FTS5 청크 검색."""
    conn = get_connection()
    try:
        # 파일명 검색
        name_rows = conn.execute("""
            SELECT id as file_id, display_name, original_path, file_type
            FROM file_links
            WHERE display_name LIKE ? AND status='OK'
            LIMIT ?
        """, (f"%{query}%", top_k)).fetchall()

        # 청크 내용 검색
        chunk_rows = conn.execute("""
            SELECT fl.id as file_id, fl.display_name, fl.original_path, fl.file_type,
                   c.content as snippet
            FROM fts_chunks f
            JOIN chunks c ON c.id = f.chunk_id
            JOIN file_links fl ON fl.id = c.file_id
            WHERE fts_chunks MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (query, top_k)).fetchall()

        # 중복 제거 (file_id 기준)
        seen = set()
        results = []
        for r in list(name_rows) + list(chunk_rows):
            d = dict(r)
            if d["file_id"] not in seen:
                seen.add(d["file_id"])
                results.append(d)
        return results[:top_k]
    except Exception as e:
        logger.warning("파일 검색 오류: %s", e)
        return []
    finally:
        conn.close()


# ──────────────────────────────────────────
# external_apis CRUD
# ──────────────────────────────────────────

def add_external_api(
    name: str, endpoint: str,
    ttl_seconds: int = 3600,
    auth_header: Optional[str] = None,
) -> dict:
    conn = get_connection()
    try:
        cur = conn.execute("""
            INSERT INTO external_apis(name, endpoint, ttl_seconds, auth_header)
            VALUES(?,?,?,?) RETURNING *
        """, (name, endpoint, ttl_seconds, auth_header))
        row = cur.fetchone()
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def get_all_external_apis() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM external_apis ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_external_api(api_id: int) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM external_apis WHERE id=?", (api_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_external_api(api_id: int, **kwargs) -> Optional[dict]:
    allowed = {"name", "endpoint", "ttl_seconds", "auth_header"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return get_external_api(api_id)
    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [api_id]
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE external_apis SET {set_clause}, updated_at=datetime('now','localtime') WHERE id=?",
            values
        )
        conn.commit()
        return get_external_api(api_id)
    finally:
        conn.close()


def delete_external_api(api_id: int) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM external_apis WHERE id=?", (api_id,))
        conn.commit()
    finally:
        conn.close()
