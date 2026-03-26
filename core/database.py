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
            query_hash    TEXT    NOT NULL,    -- 요청 파라미터의 해시값
            response_data TEXT    NOT NULL,
            created_at    DATETIME DEFAULT (datetime('now','localtime')),
            expires_at    DATETIME NOT NULL
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