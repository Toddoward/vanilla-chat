"""
core/file_engine.py
파일 처리 — 청킹, 임베딩, file_links 레지스트리, 백그라운드 경로 검증 스케줄러
"""

import asyncio
import logging
import mimetypes
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────
# 지원 파일 타입
# ──────────────────────────────────────────
SUPPORTED_TYPES = {
    ".pdf":  "pdf",
    ".docx": "docx",
    ".txt":  "txt",
    ".md":   "txt",
    ".png":  "image",
    ".jpg":  "image",
    ".jpeg": "image",
    ".webp": "image",
}


def detect_file_type(path: str) -> str:
    ext = Path(path).suffix.lower()
    return SUPPORTED_TYPES.get(ext, "unknown")


# ──────────────────────────────────────────
# 텍스트 추출
# ──────────────────────────────────────────

def extract_text(file_path: str, file_type: str) -> str:
    """파일에서 텍스트 추출. 이미지는 빈 문자열 반환 (VLM 처리는 별도)."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"파일 없음: {file_path}")

    if file_type == "txt":
        return path.read_text(encoding="utf-8", errors="ignore")

    elif file_type == "pdf":
        try:
            import fitz  # pymupdf
            doc = fitz.open(file_path)
            return "\n".join(page.get_text() for page in doc)
        except ImportError:
            logger.warning("pymupdf 미설치 — PDF 텍스트 추출 불가")
            return ""

    elif file_type == "docx":
        try:
            from docx import Document
            doc = Document(file_path)
            return "\n".join(p.text for p in doc.paragraphs)
        except ImportError:
            logger.warning("python-docx 미설치 — DOCX 텍스트 추출 불가")
            return ""

    elif file_type == "image":
        return ""  # VLM이 별도 처리

    return ""


# ──────────────────────────────────────────
# 텍스트 청킹
# ──────────────────────────────────────────

def chunk_text(text: str, chunk_size: int = 512, overlap: int = 64) -> list[str]:
    """텍스트를 청크 단위로 분할."""
    if not text.strip():
        return []

    words = text.split()
    chunks = []
    start  = 0

    while start < len(words):
        end   = min(start + chunk_size, len(words))
        chunk = " ".join(words[start:end])
        if chunk.strip():
            chunks.append(chunk)
        if end == len(words):
            break
        start = end - overlap  # 오버랩

    return chunks


# ──────────────────────────────────────────
# 임베딩 처리 (BGE-M3 via FlagEmbedding)
# ──────────────────────────────────────────

_bge_model = None

def get_bge_model():
    global _bge_model
    if _bge_model is None:
        try:
            from FlagEmbedding import BGEM3FlagModel
            _bge_model = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True)
            logger.info("BGE-M3 모델 로드 완료")
        except Exception as e:
            logger.error("FlagEmbedding 로드 실패: %s", e)
            raise
    return _bge_model


def embed_chunks(chunks: list[str]) -> list[list[float]]:
    """청크 리스트를 Dense 벡터로 변환."""
    model = get_bge_model()
    result = model.encode(
        chunks,
        batch_size=12,
        max_length=512,
        return_dense=True,
        return_sparse=False,
        return_colbert_vecs=False,
    )
    return result["dense_vecs"].tolist()


def embed_chunks_with_sparse(chunks: list[str]) -> tuple[list[list[float]], list[dict]]:
    """
    청크 리스트를 Dense + Sparse 벡터로 동시 변환.
    H-4: BGE-M3 Sparse 활성화 — 전문 용어/고유명사 매칭 정확도 향상.
    반환: (dense_vecs, sparse_vecs)
      sparse_vecs: [{"indices": [int, ...], "values": [float, ...]}, ...]
    """
    model = get_bge_model()
    try:
        result = model.encode(
            chunks,
            batch_size=12,
            max_length=512,
            return_dense=True,
            return_sparse=True,
            return_colbert_vecs=False,
        )
        dense_vecs = result["dense_vecs"].tolist()
        # sparse_vecs: list of {token_id: weight} dict
        raw_sparse = result.get("lexical_weights", [])
        sparse_vecs = []
        for sv in raw_sparse:
            if isinstance(sv, dict):
                indices = list(sv.keys())
                values  = [float(sv[k]) for k in indices]
            else:
                indices, values = [], []
            sparse_vecs.append({"indices": indices, "values": values})
        return dense_vecs, sparse_vecs
    except Exception as e:
        logger.warning("Sparse 임베딩 실패 — Dense만 사용: %s", e)
        dense_vecs = embed_chunks(chunks)
        sparse_vecs = [{"indices": [], "values": []} for _ in chunks]
        return dense_vecs, sparse_vecs


# ──────────────────────────────────────────
# 리랭커 (BGE-Reranker-v2-M3 via FlagEmbedding)
# ──────────────────────────────────────────

_reranker_model = None

def get_reranker():
    global _reranker_model
    if _reranker_model is None:
        try:
            from FlagEmbedding import FlagReranker
            _reranker_model = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True)
            logger.info("BGE-Reranker-v2-M3 로드 완료")
        except Exception as e:
            logger.warning("FlagEmbedding 리랭커 로드 실패: %s", e)
    return _reranker_model


def rerank(query: str, documents: list[str]) -> list[float]:
    """문서 리스트를 쿼리 기준으로 재순위. 점수 리스트 반환."""
    reranker = get_reranker()
    if not reranker or not documents:
        return [1.0] * len(documents)
    pairs  = [[query, doc] for doc in documents]
    scores = reranker.compute_score(pairs, normalize=True)
    return scores if isinstance(scores, list) else [scores]


# ──────────────────────────────────────────
# 파일 등록 파이프라인 (비동기)
# ──────────────────────────────────────────

async def register_file(
    file_path: str,
    display_name: Optional[str],
    config: dict,
    progress_callback=None,  # (file_id, pct) -> None
) -> dict:
    """
    파일 등록 전체 파이프라인:
    1. file_links 레지스트리 등록
    2. 텍스트 추출
    3. 청킹
    4. 임베딩
    5. DB 저장
    """
    from core.database import (
        add_file_link, update_file_link_status,
        add_chunks, add_vectors,
    )

    rag_cfg    = config.get("rag", {})
    chunk_size = rag_cfg.get("chunk_size", 512)
    overlap    = rag_cfg.get("chunk_overlap", 64)

    file_type    = detect_file_type(file_path)
    display_name = display_name or Path(file_path).name

    # 1. DB에 file_links 등록
    file_record = add_file_link(
        original_path=file_path,
        display_name=display_name,
        file_type=file_type,
        embedding_status="running",
    )
    file_id = file_record["id"]

    try:
        if progress_callback:
            await progress_callback(file_id, 10)

        # 2. 텍스트 추출 — 이미지는 VLM 분석으로 별도 처리
        loop = asyncio.get_event_loop()
        if file_type == "image":
            # G-11: 이미지 파일 → VLM으로 내용 분석 후 텍스트로 저장
            vision_provider = config.get("_vision_provider")
            if vision_provider is None:
                logger.warning("이미지 RAG: vision_provider 없음 — 임베딩 건너뜀 [file_id=%d]", file_id)
                update_file_link_status(file_id, embedding_status="done")
                if progress_callback:
                    await progress_callback(file_id, 100)
                return {"file_id": file_id, "status": "done", "chunks": 0}

            import base64 as _b64
            with open(file_path, "rb") as _f:
                image_b64 = _b64.b64encode(_f.read()).decode()

            vis_cfg = config.get("vision", {}).get("preprocess", {})
            prompt = (
                "이 이미지의 모든 내용을 상세히 설명해주세요. "
                "텍스트, 도표, 그래프, 도형, 색상 정보를 모두 포함하세요. "
                "텍스트가 있다면 정확히 추출하세요."
            )
            try:
                text = await vision_provider.vision(
                    image_b64, prompt,
                    resize=vis_cfg.get("resize", False),
                    max_size=vis_cfg.get("max_size", 512),
                )
                logger.info("이미지 VLM 분석 완료 [file_id=%d] %d자", file_id, len(text))
            except Exception as e:
                logger.warning("이미지 VLM 분석 실패 [file_id=%d]: %s", file_id, e)
                text = ""
        else:
            text = await loop.run_in_executor(None, extract_text, file_path, file_type)

        if progress_callback:
            await progress_callback(file_id, 30)

        # 3. 청킹
        chunks = chunk_text(text, chunk_size, overlap)
        logger.info("파일 청킹 완료 [file_id=%d] %d청크", file_id, len(chunks))

        if progress_callback:
            await progress_callback(file_id, 50)

        if chunks:
            # 4. Dense + Sparse 임베딩 (동기 → 스레드풀)
            dense_vecs, sparse_vecs = await loop.run_in_executor(
                None, embed_chunks_with_sparse, chunks
            )

            if progress_callback:
                await progress_callback(file_id, 80)

            # 5. DB 저장
            from core.database import add_chunks, add_vectors, add_sparse_vectors
            chunk_ids = add_chunks(file_id, chunks)
            add_vectors(chunk_ids, dense_vecs)
            add_sparse_vectors(chunk_ids, sparse_vecs)

        # 완료
        update_file_link_status(file_id, embedding_status="done")
        if progress_callback:
            await progress_callback(file_id, 100)

        logger.info("파일 등록 완료 [file_id=%d] %s", file_id, display_name)
        return {"file_id": file_id, "status": "done", "chunks": len(chunks)}

    except Exception as e:
        update_file_link_status(file_id, embedding_status="error")
        logger.error("파일 등록 실패 [file_id=%d]: %s", file_id, e)
        raise


async def reembed_all_files(config: dict, progress_callback=None) -> dict:
    """
    모든 등록 파일을 재임베딩.
    임베딩 모델 교체 후 차원 불일치 해소 목적.
    1. vec_chunks 테이블 삭제
    2. 모든 파일 순차 재임베딩
    """
    from core.database import (
        get_all_file_links, update_file_link_status,
        add_chunks, add_vectors, add_sparse_vectors,
        delete_file_chunks, drop_vec_table,
    )

    drop_vec_table()  # 기존 Dense 벡터 테이블 삭제
    # H-6: sparse_chunks도 초기화
    try:
        from core.database import get_connection
        conn = get_connection()
        conn.execute("DELETE FROM sparse_chunks")
        conn.commit()
        conn.close()
        logger.info("sparse_chunks 초기화 완료")
    except Exception as e:
        logger.warning("sparse_chunks 초기화 실패: %s", e)

    files = get_all_file_links()
    if not files:
        return {"reembedded": 0, "errors": 0}

    rag_cfg    = config.get("rag", {})
    chunk_size = rag_cfg.get("chunk_size", 512)
    overlap    = rag_cfg.get("chunk_overlap", 64)

    done_count  = 0
    error_count = 0
    total       = len(files)

    for idx, f in enumerate(files):
        file_id   = f["id"]
        file_path = f["original_path"]
        file_type = f.get("file_type") or detect_file_type(file_path)

        try:
            update_file_link_status(file_id, embedding_status="running")
            delete_file_chunks(file_id)

            loop = asyncio.get_event_loop()
            text = await loop.run_in_executor(None, extract_text, file_path, file_type)
            chunks = chunk_text(text, chunk_size, overlap)

            if chunks:
                dense_vecs, sparse_vecs = await loop.run_in_executor(
                    None, embed_chunks_with_sparse, chunks
                )
                chunk_ids = add_chunks(file_id, chunks)
                add_vectors(chunk_ids, dense_vecs)
                add_sparse_vectors(chunk_ids, sparse_vecs)

            update_file_link_status(file_id, embedding_status="done")
            done_count += 1
            logger.info("재임베딩 완료 [%d/%d] file_id=%d", idx + 1, total, file_id)

        except Exception as e:
            update_file_link_status(file_id, embedding_status="error")
            error_count += 1
            logger.error("재임베딩 실패 [file_id=%d]: %s", file_id, e)

        if progress_callback:
            pct = int((idx + 1) / total * 100)
            await progress_callback(pct)

    return {"reembedded": done_count, "errors": error_count}


# ──────────────────────────────────────────
# 백그라운드 경로 검증 스케줄러
# ──────────────────────────────────────────

_verification_task: Optional[asyncio.Task] = None


async def start_path_verification_scheduler(interval_minutes: int = 10):
    """앱 시작 시 백그라운드에서 주기적으로 file_links 경로 검증."""
    global _verification_task
    if _verification_task and not _verification_task.done():
        return
    _verification_task = asyncio.create_task(
        _verification_loop(interval_minutes)
    )
    logger.info("파일 경로 검증 스케줄러 시작 (주기: %d분)", interval_minutes)


async def _verification_loop(interval_minutes: int):
    while True:
        try:
            await _verify_all_paths()
        except Exception as e:
            logger.error("경로 검증 오류: %s", e)
        await asyncio.sleep(interval_minutes * 60)


async def _verify_all_paths():
    """모든 file_links의 original_path 존재 여부 확인 및 status 갱신."""
    from core.database import get_all_file_links, update_file_link_status

    files = get_all_file_links()
    broken = []
    now    = datetime.now().isoformat()

    for f in files:
        exists = Path(f["original_path"]).exists()
        new_status = "OK" if exists else "BROKEN"
        if f["status"] != new_status:
            update_file_link_status(
                f["id"],
                status=new_status,
                last_verified_at=now,
            )
            if new_status == "BROKEN":
                broken.append(f["display_name"] or f["original_path"])
        else:
            # 정상이라도 last_verified_at 갱신
            update_file_link_status(f["id"], last_verified_at=now)

    if broken:
        logger.warning("경로 끊김 파일 %d개: %s", len(broken), broken)


def stop_path_verification_scheduler():
    global _verification_task
    if _verification_task:
        _verification_task.cancel()
        _verification_task = None