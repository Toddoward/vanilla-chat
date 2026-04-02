"""
app.py
Vanilla Chat — FastAPI 앱 진입점
설정 로드 → DB 초기화 → 모델 슬롯 초기화 → 라우터 등록
"""

import json
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import yaml
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, UploadFile, File
import shutil
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.database import (
    init_db, get_state, set_state,
    create_session, get_sessions, get_session, update_session,
    delete_sessions, add_message, get_messages, get_message_count,
    add_file_link, get_all_file_links, get_file_link,
    update_file_link_status, delete_file_link,
    add_chunks, add_vectors,
    delete_last_assistant_message,
)
from core.providers import (
    model_manager,
    check_ollama_connection,
    get_model_context_length,
    list_ollama_models,
    fetch_all_capabilities,
    OLLAMA_BASE_URL,
)
import httpx as httpx
from core.context_manager import get_context_manager, clear_context_manager
from core.file_engine import (
    register_file,
    start_path_verification_scheduler,
    stop_path_verification_scheduler,
)

# ──────────────────────────────────────────
# 로깅 설정
# ──────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────
# 설정 로드
# ──────────────────────────────────────────
CONFIG_PATH = Path("app_config.yaml")
THEME_PATH  = Path("theme_config.json")


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        logger.warning("app_config.yaml 없음 — 기본값 사용")
        return {}
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_config(config: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.dump(config, f, allow_unicode=True, default_flow_style=False)


# ──────────────────────────────────────────
# 백그라운드 capabilities 캐시 로더
# ──────────────────────────────────────────
async def _load_capabilities_bg(app: FastAPI) -> None:
    """앱 시작 후 백그라운드에서 모든 모델 capabilities를 병렬 조회하여 캐싱."""
    try:
        caps = await fetch_all_capabilities()
        app.state.all_capabilities = caps
        logger.info("모델 capabilities 캐시 완료 (백그라운드): %d개", len(caps))
    except Exception as e:
        logger.warning("capabilities 백그라운드 캐시 실패: %s", e)


# ──────────────────────────────────────────
# Lifespan (시작/종료 훅)
# ──────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── 시작
    logger.info("🍨 Vanilla Chat 시작 중...")

    # 1. 설정 로드
    config = load_config()
    app.state.config = config

    # 2. DB 초기화
    init_db()

    # 3. 모델 슬롯 초기화
    model_manager.init(config)

    # 4. Ollama 연결 확인
    connected, _ = await check_ollama_connection()
    model_manager.is_connected = connected
    if connected:
        ctx_len = await get_model_context_length(model_manager.response_model_name)
        model_manager.context_length = ctx_len
        logger.info("Ollama 연결 OK | 모델: %s | 컨텍스트: %d",
                    model_manager.response_model_name, ctx_len)
        # 5. capabilities 캐시 — 백그라운드에서 병렬 조회 (시작 지연 없음)
        app.state.all_capabilities = {}  # 빈 캐시로 즉시 시작
        import asyncio
        asyncio.create_task(_load_capabilities_bg(app))
    else:
        logger.warning("Ollama 연결 실패 — 서버 실행 후 재시도 필요")
        app.state.all_capabilities = {}

    logger.info("🍨 Vanilla Chat 준비 완료")

    # 5. 파일 경로 검증 스케줄러 시작
    verify_interval = config.get("file_links", {}).get("verify_interval_minutes", 10)
    await start_path_verification_scheduler(verify_interval)

    yield

    # ── 종료
    stop_path_verification_scheduler()
    logger.info("🍨 Vanilla Chat 종료")


# ──────────────────────────────────────────
# FastAPI 앱
# ──────────────────────────────────────────
app = FastAPI(
    title="Vanilla Chat",
    description="Zero-config 로컬 에이전틱 챗봇",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
)

app.mount("/static", StaticFiles(directory="static"), name="static")


# ──────────────────────────────────────────
# 라우터
# ──────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    """SPA 단일 페이지 서빙."""
    html = Path("templates/index.html").read_text(encoding="utf-8")
    return HTMLResponse(content=html)


@app.get("/theme_config.json")
async def get_theme_config():
    """theme_config.json 서빙 (JS에서 직접 fetch). 빈 파일이면 빈 객체 반환."""
    if THEME_PATH.exists():
        text = THEME_PATH.read_text(encoding="utf-8").strip()
        if text:
            return JSONResponse(json.loads(text))
    return JSONResponse({})


@app.get("/api/app-info")
async def get_app_info():
    """앱 이름, 로고 경로 등 UI 기본 정보 반환."""
    config = load_config()
    app_cfg = config.get("app", {})
    return {
        "name":                app_cfg.get("name", "Vanilla Chat"),
        "logo":                app_cfg.get("logo", "static/images/logo_color.png"),
        "logo_emoji_fallback": app_cfg.get("logo_emoji_fallback", "🍨"),
    }


@app.get("/api/app-state")
async def get_app_state():
    """
    Greeting 조건 확인.
    last_visited_date 반환 → JS에서 시간대/당일 재방문 분기.
    """
    from datetime import date
    today = date.today().isoformat()
    last_visited = get_state("last_visited_date")
    is_returning = (last_visited == today)

    # 방문일 갱신
    set_state("last_visited_date", today)

    return {
        "last_visited_date": last_visited,
        "is_returning": is_returning,
        "today": today,
    }


@app.get("/api/status")
async def get_status():
    """헤더 모델 연결 상태 확인용."""
    connected, _ = await check_ollama_connection()
    model_manager.is_connected = connected
    from core.database import get_embedding_dim
    from core.file_engine import get_bge_model
    stored_dim = get_embedding_dim()
    current_dim = None
    try:
        bge = get_bge_model()
        if bge is not None:
            current_dim = bge.get_sentence_embedding_dimension()
    except Exception:
        pass
    dim_mismatch = (
        stored_dim is not None and
        current_dim is not None and
        stored_dim != current_dim
    )

    # G-9: GPU 사용 여부 감지 — Ollama /api/ps의 size_vram 기반
    gpu_available = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(f"{OLLAMA_BASE_URL}/api/ps")
            if resp.status_code == 200:
                models_running = resp.json().get("models", [])
                gpu_available = any(m.get("size_vram", 0) > 0 for m in models_running)
    except Exception:
        pass

    return {
        "connected": connected,
        "model": model_manager.response_model_name,
        "context_length": model_manager.context_length,
        "embedding_dim": stored_dim,
        "dim_mismatch": dim_mismatch,
        "gpu_available": gpu_available,
    }


@app.get("/api/models")
async def get_models():
    """Ollama에서 사용 가능한 모델 목록."""
    models = await list_ollama_models()
    return {"models": models}


@app.get("/api/models/all-capabilities")
async def get_all_capabilities():
    """설치된 모든 모델의 capabilities 반환 (캐시 사용)."""
    cached = getattr(app.state, "all_capabilities", None)
    if cached is None:
        # 캐시 없으면 실시간 조회
        cached = await fetch_all_capabilities()
        app.state.all_capabilities = cached
    return cached


@app.get("/api/models/capabilities")
async def get_model_capabilities(model: str):
    """특정 모델의 capabilities 조회 (thinking/vision/tools 지원 여부)."""
    from core.providers import OllamaProvider
    provider = OllamaProvider(model)
    caps = await provider.get_capabilities()
    return {"model": model, **caps}


@app.get("/api/config")
async def get_config():
    """현재 app_config.yaml 반환."""
    return load_config()


@app.patch("/api/config")
async def patch_config(updates: dict):
    """app_config.yaml 항목 수정 후 즉시 저장."""
    config = load_config()
    _deep_update(config, updates)
    save_config(config)
    app.state.config = config
    model_manager.init(config)
    note = "모델 변경은 새 채팅부터 적용됩니다." if "models" in updates else None
    return {"ok": True, "config": config, "note": note}


# ──────────────────────────────────────────
# 파일 API  (3-6)
# ──────────────────────────────────────────

# 진행률 공유 저장소 (file_id -> pct)
_embedding_progress: dict[int, int] = {}


@app.get("/api/files")
async def api_get_files():
    files = get_all_file_links()
    return {"files": files}


@app.get("/api/files/by-name")
async def api_get_file_by_name(name: str):
    """파일명으로 file_id 역조회 — 재열람 시 첨부 파일 열람용."""
    files = get_all_file_links()
    matched = next((f for f in files if f.get("display_name") == name), None)
    if not matched:
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    return {"file_id": matched["id"], "name": matched["display_name"],
            "file_type": matched.get("file_type"), "status": matched.get("embedding_status")}


@app.get("/api/files/status")
async def api_file_status():
    """임베딩 진행률 SSE 스트림."""
    async def event_gen():
        while True:
            if _embedding_progress:
                yield "data: " + json.dumps(_embedding_progress) + "\n\n"
            else:
                yield "data: {}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/files/{file_id}")
async def api_get_file(file_id: int):
    f = get_file_link(file_id)
    if not f:
        raise HTTPException(404, "파일 없음")
    return f
    """
    파일 등록 요청.
    body: { "path": "/abs/path/to/file", "display_name": "optional" }
    """
    path = body.get("path", "")
    if not path:
        raise HTTPException(400, "path 필수")

    from pathlib import Path as P
    if not P(path).exists():
        raise HTTPException(400, f"파일 없음: {path}")

    config = load_config()
    display_name = body.get("display_name")

    async def progress_cb(file_id: int, pct: int):
        _embedding_progress[file_id] = pct

    background.add_task(
        register_file, path, display_name, config, progress_cb
    )
    # 즉시 레코드 생성해서 file_id 반환
    from core.file_engine import detect_file_type
    file_type = detect_file_type(path)
    record = add_file_link(
        original_path=path,
        display_name=display_name or P(path).name,
        file_type=file_type,
        embedding_status="pending",
    )
    return {"file_id": record["id"], "status": "queued"}


@app.delete("/api/files/{file_id}")
async def api_delete_file(file_id: int):
    delete_file_link(file_id)
    _embedding_progress.pop(file_id, None)
    return {"deleted": file_id}


@app.post("/api/files/{file_id}/open")
async def api_open_file(file_id: int):
    """OS 기본 앱으로 파일 열기."""
    record = get_file_link(file_id)
    if not record:
        raise HTTPException(404, "파일 없음")
    path = record["original_path"]
    if not Path(path).exists():
        raise HTTPException(404, f"파일을 찾을 수 없습니다: {path}")
    try:
        import sys as _sys, subprocess as _sub
        if _sys.platform == "win32":
            import os as _os
            _os.startfile(path)
        elif _sys.platform == "darwin":
            _sub.Popen(["open", path])
        else:
            _sub.Popen(["xdg-open", path])
        return {"opened": path}
    except Exception as e:
        raise HTTPException(500, f"파일 열기 실패: {e}")


@app.post("/api/files/tmp_upload")
async def api_tmp_upload(file: UploadFile = File(...)):
    """채팅창 비이미지 파일 첨부 → uploads_tmp 임시 저장 → tmp_path 반환.
    실제 등록은 사용자가 store_file 도구를 통해 요청할 때 수행됨."""
    upload_dir = Path("storage/uploads_tmp")
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / file.filename
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"name": file.filename, "tmp_path": str(dest)}


@app.post("/api/files/upload")
async def api_upload_file(background: BackgroundTasks, file: UploadFile = File(...)):
    """브라우저에서 파일 업로드 → storage/files/ 영구 저장 → 등록 파이프라인 실행."""
    # 브라우저 업로드는 원본 경로를 알 수 없으므로 storage/files/를 영구 저장소로 사용
    files_dir = Path("storage/files")
    files_dir.mkdir(parents=True, exist_ok=True)
    dest = files_dir / file.filename

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    config = load_config()
    # G-11: 이미지 RAG를 위해 vision_provider를 config에 주입
    config["_vision_provider"] = model_manager.get("vision")

    from core.file_engine import detect_file_type
    record = add_file_link(
        original_path=str(dest),
        display_name=file.filename,
        file_type=detect_file_type(file.filename),
        embedding_status="pending",
    )
    file_id = record["id"]
    _embedding_progress[file_id] = 0

    async def progress_cb(fid: int, pct: int):
        _embedding_progress[fid] = pct
        if pct >= 100:
            # 3초 후 진행률 항목 제거 → 뱃지 자동 소멸
            import asyncio
            await asyncio.sleep(3)
            _embedding_progress.pop(fid, None)

    # register_file에 기존 file_id 전달 (내부에서 add_file_link 재호출 안 함)
    background.add_task(
        _run_register_file, file_id, str(dest), file.filename, config, progress_cb
    )
    return {"file_id": file_id, "status": "queued"}


async def _run_register_file(file_id: int, path: str, display_name: str, config: dict, progress_cb):
    """file_id를 외부에서 받아 register_file 파이프라인 실행 (add_file_link 스킵)."""
    from core.file_engine import extract_text, chunk_text, embed_chunks, detect_file_type
    import asyncio

    rag_cfg    = config.get("rag", {})
    chunk_size = rag_cfg.get("chunk_size", 512)
    overlap    = rag_cfg.get("chunk_overlap", 64)
    file_type  = detect_file_type(path)

    try:
        update_file_link_status(file_id, embedding_status="running")
        if progress_cb: await progress_cb(file_id, 10)

        loop = asyncio.get_event_loop()

        # G-11: 이미지 파일 → VLM 분석
        if file_type == "image":
            vision_provider = config.get("_vision_provider")
            if vision_provider is None:
                logger.warning("이미지 RAG: vision_provider 없음 [file_id=%d]", file_id)
                update_file_link_status(file_id, embedding_status="done")
                if progress_cb: await progress_cb(file_id, 100)
                return
            import base64 as _b64
            with open(path, "rb") as _f:
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
            except Exception as e:
                logger.warning("이미지 VLM 분석 실패 [file_id=%d]: %s", file_id, e)
                text = ""
        else:
            text = await loop.run_in_executor(None, extract_text, path, file_type)

        if progress_cb: await progress_cb(file_id, 30)

        chunks = chunk_text(text, chunk_size, overlap)
        if progress_cb: await progress_cb(file_id, 50)

        if chunks:
            vectors = await loop.run_in_executor(None, embed_chunks, chunks)
            if progress_cb: await progress_cb(file_id, 80)
            chunk_ids = add_chunks(file_id, chunks)
            add_vectors(chunk_ids, vectors)

        update_file_link_status(file_id, embedding_status="done")
        if progress_cb: await progress_cb(file_id, 100)
        logger.info("파일 등록 완료 [file_id=%d]", file_id)

    except Exception as e:
        update_file_link_status(file_id, embedding_status="error")
        _embedding_progress.pop(file_id, None)
        logger.error("파일 등록 실패 [file_id=%d]: %s", file_id, e)


@app.post("/api/files/reembed")
async def api_reembed_all(background: BackgroundTasks):
    """모든 파일 재임베딩 (임베딩 모델 교체 후 차원 불일치 해소)."""
    from core.file_engine import reembed_all_files
    config = load_config()

    async def _run():
        result = await reembed_all_files(config)
        logger.info("전체 재임베딩 완료: %s", result)

    background.add_task(_run)
    return {"status": "started"}


# ──────────────────────────────────────────
# 외부 API CRUD  (4-3)
# ──────────────────────────────────────────
from core.database import (
    add_external_api, get_all_external_apis,
    get_external_api, update_external_api, delete_external_api,
)

class ExternalApiCreate(BaseModel):
    name: str
    endpoint: str
    ttl_seconds: int = 3600
    auth_header: Optional[str] = None

class ExternalApiUpdate(BaseModel):
    name: Optional[str] = None
    endpoint: Optional[str] = None
    ttl_seconds: Optional[int] = None
    auth_header: Optional[str] = None


@app.get("/api/external-apis")
async def api_get_external_apis():
    return {"apis": get_all_external_apis()}


@app.post("/api/external-apis")
async def api_create_external_api(body: ExternalApiCreate):
    record = add_external_api(
        name=body.name,
        endpoint=body.endpoint,
        ttl_seconds=body.ttl_seconds,
        auth_header=body.auth_header,
    )
    return record


@app.patch("/api/external-apis/{api_id}")
async def api_update_external_api(api_id: int, body: ExternalApiUpdate):
    kwargs = {k: v for k, v in body.dict().items() if v is not None}
    return update_external_api(api_id, **kwargs)


@app.delete("/api/external-apis/{api_id}")
async def api_delete_external_api(api_id: int):
    delete_external_api(api_id)
    return {"deleted": api_id}


@app.post("/api/external-apis/{api_id}/test")
async def api_test_external_api(api_id: int):
    rec = get_external_api(api_id)
    if not rec:
        raise HTTPException(404, "API 없음")
    import httpx
    headers = {}
    if rec.get("auth_header"):
        headers["Authorization"] = rec["auth_header"]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(rec["endpoint"], headers=headers)
        resp.raise_for_status()
    return {"status": "ok", "status_code": resp.status_code}


@app.get("/api/search")
async def api_search(q: str = "", limit: int = 20):
    """통합 검색 — 채팅 메시지 + 파일 (FTS5)."""
    from core.database import search_sessions, search_files, get_sessions, get_all_file_links
    if q.strip():
        sessions = search_sessions(q, top_k=limit)
        files    = search_files(q, top_k=limit)
    else:
        # 검색어 없으면 최근 채팅/파일 기본 표시
        sessions = get_sessions()[:limit]
        files    = get_all_file_links()[:limit]
    return {"sessions": sessions, "files": files, "query": q}


def _deep_update(base: dict, updates: dict) -> None:
    for k, v in updates.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v


# ──────────────────────────────────────────
# 세션 API  (2-1)
# ──────────────────────────────────────────

class SessionCreate(BaseModel):
    title: str = "새 대화"

class SessionUpdate(BaseModel):
    title: Optional[str] = None
    is_favorite: Optional[int] = None
    system_prompt: Optional[str] = None
    thinking: Optional[int] = None
    agentic: Optional[int] = None
    vision_resize: Optional[int] = None

class SessionDeleteBody(BaseModel):
    ids: list[int]


@app.post("/api/sessions")
async def api_create_session(body: SessionCreate):
    session = create_session(body.title)
    return session


@app.get("/api/sessions")
async def api_get_sessions():
    sessions = get_sessions()
    # 메시지 수 포함
    for s in sessions:
        s["message_count"] = get_message_count(s["id"])
    return {"sessions": sessions}


@app.get("/api/sessions/{session_id}")
async def api_get_session(session_id: int):
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "세션 없음")
    session["messages"] = get_messages(session_id)
    return session


@app.patch("/api/sessions/{session_id}")
async def api_update_session(session_id: int, body: SessionUpdate):
    kwargs = {}
    if body.title is not None:          kwargs["title"]          = body.title
    if body.is_favorite is not None:    kwargs["is_favorite"]    = body.is_favorite
    if body.system_prompt is not None:  kwargs["system_prompt"]  = body.system_prompt
    if body.thinking is not None:       kwargs["thinking"]       = body.thinking
    if body.agentic is not None:        kwargs["agentic"]        = body.agentic
    if body.vision_resize is not None:  kwargs["vision_resize"]  = body.vision_resize
    updated = update_session(session_id, **kwargs)
    if not updated:
        raise HTTPException(404, "세션 없음")
    return updated


@app.delete("/api/sessions")
async def api_delete_sessions(body: SessionDeleteBody):
    count = delete_sessions(body.ids)
    for sid in body.ids:
        clear_context_manager(sid)
    return {"deleted": count}


# ──────────────────────────────────────────
# 채팅 SSE 스트리밍  (2-2)
# ──────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: int
    message: str
    is_regenerate: bool = False
    images: list[dict] = []        # [{ "name": str, "data": str (base64) }]
    upload_paths: list[dict] = []  # [{ "name": str, "tmp_path": str }]


ABORT_PLACEHOLDER = "_(응답이 중단되었습니다)_"
FAIL_PLACEHOLDER  = "_(추론 중 응답 생성에 실패했습니다. 재생성을 시도해 주세요)_"


def _extract_thinking_and_response(text: str) -> tuple[str | None, str]:
    """
    full_response 텍스트에서 thinking과 response를 분리.
    - </think> 있는 정상 케이스: thinking + response 분리
    - </think> 없이 중단된 케이스: 전체를 thinking으로, response는 빈 문자열
    - <think> 없는 케이스: thinking=None, 전체가 response
    """
    import re as _re
    match = _re.search(r'<think>(.*?)</think>(.*)', text, flags=_re.DOTALL)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    open_match = _re.search(r'<think>(.*)', text, flags=_re.DOTALL)
    if open_match:
        return open_match.group(1).strip(), ""
    return None, text.strip()


@app.post("/api/chat")
async def api_chat(body: ChatRequest, background: BackgroundTasks):
    session = get_session(body.session_id)
    if not session:
        raise HTTPException(404, "세션 없음")

    config           = load_config()
    app_name         = config.get("app", {}).get("name", "Vanilla Chat")
    inference_config = config.get("inference", {})

    # A-4: 시스템 프롬프트 — 세션 로컬 우선, 없으면 글로벌 fallback
    global_prompt = config.get("system_prompt", "You are a helpful assistant.")
    global_prompt = global_prompt.replace("$(name)", app_name)
    system_prompt = session.get("system_prompt") or global_prompt

    # A-5: thinking 토글 — 세션 로컬 우선, 없으면 글로벌 fallback
    session_thinking = session.get("thinking")
    think_enabled = bool(session_thinking) if session_thinking is not None \
        else inference_config.get("think", True)

    # G-3: vision 리사이즈 — 세션 로컬 우선, 없으면 글로벌 fallback
    session_resize = session.get("vision_resize")
    global_vision_cfg = config.get("vision", {}).get("preprocess", {})
    vision_resize  = bool(session_resize) if session_resize is not None \
        else global_vision_cfg.get("resize", False)
    vision_max_size = global_vision_cfg.get("max_size", 512)
    # config에 주입해서 execute_tool까지 전달
    config.setdefault("vision", {}).setdefault("preprocess", {})
    config["vision"]["preprocess"]["resize"]   = vision_resize
    config["vision"]["preprocess"]["max_size"] = vision_max_size

    response_provider = model_manager.get("response")

    ctx = get_context_manager(
        session_id=body.session_id,
        context_length=model_manager.context_length,
        system_prompt=system_prompt,
        config=config,
    )

    messages         = ctx.build_messages(body.message)
    is_first_message = get_message_count(body.session_id) == 0

    if body.is_regenerate:
        delete_last_assistant_message(body.session_id)
    else:
        # A-2: 첨부 파일명 목록 저장
        all_attachment_names = (
            [img["name"] for img in body.images] +
            [up["name"] for up in body.upload_paths]
        ) or None
        add_message(
            body.session_id, "user", body.message,
            attachments=all_attachment_names,
        )

    async def event_stream():
        from core.agents import (
            run_orchestrator_loop, analyze_images,
            TOOLS, is_image,
        )
        full_response = []
        summarizing   = False
        _saved        = False
        all_sources   = []   # GeneratorExit/finally에서 안전하게 참조
        all_files     = []

        try:
            # ── Stage 1: 오케스트레이터 루프 ──────────────────
            # A-5: 세션 로컬 agentic 설정 — null이면 글로벌 기본(활성)
            session_agentic = session.get("agentic")
            agentic_enabled = session_agentic != 0  # 0이면 명시적 비활성

            orchestrator   = await model_manager.get_orchestrator() if agentic_enabled else None
            vision_provider = model_manager.get("vision")
            tool_results   = []
            stage1_messages = list(messages)

            if orchestrator is not None:
                yield "data: " + json.dumps({"type": "agent", "agent": "orchestrating"}) + "\n\n"
                tool_results, stage1_messages = await run_orchestrator_loop(
                    orchestrator,
                    stage1_messages,
                    body.images,
                    body.upload_paths,
                    vision_provider,
                    body.message,
                    config,
                )
                # 실행된 도구 종류별 agent 이벤트 발행
                seen = set()
                for tr in tool_results:
                    tool_name = tr.get("tool", "")
                    if tool_name not in seen:
                        seen.add(tool_name)
                        agent_label = {
                            "rag_search":    "rag",
                            "list_files":    "list_files",
                            "analyze_image": "vision",
                            "store_file":    "store",
                        }.get(tool_name, tool_name)
                        yield "data: " + json.dumps({"type": "agent", "agent": agent_label}) + "\n\n"

                # D-1: store_file 성공 결과 → stored 이벤트 발행 (Data Hub 뱃지/목록 갱신)
                stored_results = [
                    tr for tr in tool_results
                    if tr.get("tool") == "store_file" and tr.get("status") == "ok"
                ]
                if stored_results:
                    yield "data: " + json.dumps({
                        "type": "stored",
                        "count": len(stored_results),
                    }) + "\n\n"

            else:
                # Fallback: 오케스트레이터 없을 때 이미지 첨부가 있으면 직접 VLM 분석
                if body.images and vision_provider:
                    yield "data: " + json.dumps({"type": "agent", "agent": "vision"}) + "\n\n"
                    img_ctx = await analyze_images(vision_provider, body.images, body.message, config)
                    if img_ctx:
                        tool_results.append({"tool": "analyze_image", "result": img_ctx, "status": "ok"})

            # ── Stage 2: 응답 생성 ────────────────────────────
            # 도구 결과를 일반 텍스트 컨텍스트로 변환 후 user 메시지에 주입
            if tool_results:
                context_text = "\n\n".join(
                    f"[{tr['tool']} 결과]\n{tr['result']}"
                    for tr in tool_results
                    if tr.get("status") == "ok"
                )
                # 컨텍스트 초과 방지: 결과 텍스트를 3000자로 제한
                if len(context_text) > 3000:
                    context_text = context_text[:3000] + "\n...(이하 생략)"
                if context_text:
                    final_messages = ctx.build_messages(
                        f"{body.message}\n\n{context_text}"
                    )
                else:
                    final_messages = ctx.build_messages(body.message)
            else:
                final_messages = ctx.build_messages(body.message)

            logger.info(
                "Stage 2 진입 [session=%d] | 메시지 수=%d | 도구결과=%d개",
                body.session_id, len(final_messages), len(tool_results)
            )

            # RAG 출처 이벤트 발행
            all_sources = []
            for tr in tool_results:
                if tr.get("tool") == "rag_search" and tr.get("sources"):
                    all_sources.extend(tr["sources"])
            if all_sources:
                yield "data: " + json.dumps({"type": "sources", "sources": all_sources}) + "\n\n"

            # list_files 결과 파일 뱃지 이벤트 발행
            all_files = []
            for tr in tool_results:
                if tr.get("tool") == "list_files" and tr.get("files"):
                    all_files.extend(tr["files"])
            if all_files:
                yield "data: " + json.dumps({"type": "files", "files": all_files}) + "\n\n"

            # 컨텍스트 요약 필요 시
            if ctx.needs_summary():
                summarizing = True
                yield "data: " + json.dumps({"type": "summarizing"}) + "\n\n"
                await ctx.summarize(response_provider)
                if not tool_results:
                    final_messages = ctx.build_messages(body.message)

            yield "data: " + json.dumps({"type": "start"}) + "\n\n"

            async for chunk in response_provider.chat(
                final_messages,
                stream=True,
                think=think_enabled,
                inference_config=inference_config,
            ):
                full_response.append(chunk)
                yield "data: " + json.dumps({"type": "chunk", "content": chunk}) + "\n\n"

            response_text = "".join(full_response)
            thinking_text, clean_response = _extract_thinking_and_response(response_text)
            add_message(
                body.session_id, "assistant", clean_response,
                thinking=thinking_text,
                sources=all_sources if all_sources else None,
                files=all_files if all_files else None,
            )
            _saved = True

            # A-3: 도구 결과 컨텍스트 포함해서 히스토리 갱신
            effective_user = body.message
            if tool_results:
                ctx_summary = "\n\n".join(
                    f"[{tr['tool']} 결과 요약]\n{tr['result'][:500]}"
                    for tr in tool_results if tr.get("status") == "ok"
                )
                if ctx_summary:
                    effective_user = f"{body.message}\n\n{ctx_summary}"
            ctx.add_exchange(effective_user, clean_response)

            yield "data: " + json.dumps({
                "type": "done",
                "usage_ratio": ctx.usage_ratio(),
                "summarized": summarizing,
            }) + "\n\n"

            if is_first_message:
                background.add_task(
                    _generate_title, body.session_id, body.message, response_text, config
                )

        except GeneratorExit:
            # 클라이언트 연결 끊김 — is_abort=True로 표시
            logger.info("클라이언트 연결 끊김 [session=%d]", body.session_id)
            if not _saved:
                raw = "".join(full_response)
                thinking_text, partial = _extract_thinking_and_response(raw)
                save_content = partial if partial.strip() else ABORT_PLACEHOLDER
                try:
                    add_message(
                        body.session_id, "assistant", save_content,
                        thinking=thinking_text,
                        sources=all_sources or None,
                    )
                    logger.info("중단 메시지 저장 [session=%d]", body.session_id)
                except Exception as save_err:
                    logger.warning("중단 저장 오류: %s", save_err)

        except Exception as e:
            logger.error("채팅 오류 [session=%d]: %s", body.session_id, e)
            yield "data: " + json.dumps({"type": "error", "message": str(e)}) + "\n\n"

        finally:
            if not _saved:
                raw = "".join(full_response)
                thinking_text, partial = _extract_thinking_and_response(raw)
                save_content = partial if partial.strip() else FAIL_PLACEHOLDER
                try:
                    add_message(
                        body.session_id, "assistant", save_content,
                        thinking=thinking_text,
                        sources=all_sources or None,
                    )
                    logger.info("실패 메시지 저장 [session=%d]: %d자", body.session_id, len(save_content))
                except Exception as save_err:
                    logger.warning("실패 저장 오류 [session=%d]: %s", body.session_id, save_err)
                if is_first_message:
                    try:
                        fallback_title = body.message.strip()[:20]
                        update_session(body.session_id, title=fallback_title)
                    except Exception:
                        pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )


# ──────────────────────────────────────────
# 제목 자동 생성  (2-7)
# ──────────────────────────────────────────

async def _generate_title(session_id: int, user_msg: str, assistant_msg: str, config: dict):
    """첫 번째 응답 완료 후 백그라운드에서 20자 이내 제목 생성. 실패 시 첫 메시지로 대체."""
    fallback_title = user_msg.strip()[:20]
    try:
        provider = model_manager.get("response")
        if provider is None:
            update_session(session_id, title=fallback_title)
            return
        prompt = (
            "다음 대화의 제목을 20자 이내로 만들어줘. "
            "제목만 출력하고 따옴표나 부연설명은 넣지 마.\n\n"
            f"사용자: {user_msg[:200]}\n"
            f"AI: {assistant_msg[:200]}"
        )
        result = []
        async for chunk in provider.chat(
            [{"role": "user", "content": prompt}],
            stream=True,
            think=False,
            inference_config={"temperature": 0.3, "num_predict": 64},
        ):
            result.append(chunk)

        title = "".join(result).strip().strip('"\'').strip()
        # </think> 태그가 있으면 그 이후 텍스트만 사용
        if '</think>' in title:
            title = title.split('</think>')[-1].strip()
        # 혹시 남은 <think> 태그 제거
        import re
        title = re.sub(r'<think>.*?</think>', '', title, flags=re.DOTALL).strip()

        final_title = title if title else fallback_title
        update_session(session_id, title=final_title)
        logger.info("제목 생성 완료 [session=%d]: %s", session_id, final_title)
    except Exception as e:
        logger.warning("제목 생성 실패 [session=%d], fallback 사용: %s", session_id, e)
        update_session(session_id, title=fallback_title)