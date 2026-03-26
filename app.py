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
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.database import (
    init_db, get_state, set_state,
    create_session, get_sessions, get_session, update_session,
    delete_sessions, add_message, get_messages, get_message_count,
)
from core.providers import (
    model_manager,
    check_ollama_connection,
    get_model_context_length,
    list_ollama_models,
)
from core.context_manager import get_context_manager, clear_context_manager

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
    else:
        logger.warning("Ollama 연결 실패 — 서버 실행 후 재시도 필요")

    logger.info("🍨 Vanilla Chat 준비 완료")
    yield

    # ── 종료
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
    return {
        "connected": connected,
        "model": model_manager.response_model_name,
        "context_length": model_manager.context_length,
    }


@app.get("/api/models")
async def get_models():
    """Ollama에서 사용 가능한 모델 목록."""
    models = await list_ollama_models()
    return {"models": models}


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
    return {"ok": True, "config": config}


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
    if body.title is not None:      kwargs["title"] = body.title
    if body.is_favorite is not None: kwargs["is_favorite"] = body.is_favorite
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


@app.post("/api/chat")
async def api_chat(body: ChatRequest, background: BackgroundTasks):
    session = get_session(body.session_id)
    if not session:
        raise HTTPException(404, "세션 없음")

    config = load_config()
    system_prompt = config.get("system_prompt", "You are a helpful assistant.")
    provider = model_manager.get("response")

    ctx = get_context_manager(
        session_id=body.session_id,
        context_length=model_manager.context_length,
        system_prompt=system_prompt,
        config=config,
    )

    messages = ctx.build_messages(body.message)
    is_first_message = get_message_count(body.session_id) == 0

    async def event_stream():
        full_response = []
        summarizing = False

        try:
            # 요약 필요 여부 선제 확인
            if ctx.needs_summary():
                summarizing = True
                yield "data: " + json.dumps({"type": "summarizing"}) + "\n\n"
                await ctx.summarize(provider)
                messages_updated = ctx.build_messages(body.message)
            else:
                messages_updated = messages

            # 스트리밍 응답
            yield "data: " + json.dumps({"type": "start"}) + "\n\n"

            async for chunk in provider.chat(messages_updated, stream=True):
                full_response.append(chunk)
                yield "data: " + json.dumps({"type": "chunk", "content": chunk}) + "\n\n"

            response_text = "".join(full_response)

            # DB 저장
            add_message(body.session_id, "user", body.message)
            add_message(body.session_id, "assistant", response_text)

            # 컨텍스트 히스토리 갱신
            ctx.add_exchange(body.message, response_text)

            yield "data: " + json.dumps({
                "type": "done",
                "usage_ratio": ctx.usage_ratio(),
                "summarized": summarizing,
            }) + "\n\n"

            # 첫 메시지이면 백그라운드 제목 자동 생성 (2-7)
            if is_first_message:
                background.add_task(
                    _generate_title, body.session_id, body.message, response_text, config
                )

        except Exception as e:
            logger.error("채팅 오류 [session=%d]: %s", body.session_id, e)
            yield "data: " + json.dumps({"type": "error", "message": str(e)}) + "\n\n"

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
        ):
            result.append(chunk)

        title = "".join(result).strip().strip('"\'').strip()[:20]
        # <think> 태그 포함 시 제거
        import re
        title = re.sub(r'<think>.*?</think>', '', title, flags=re.DOTALL).strip()[:20]

        final_title = title if title else fallback_title
        update_session(session_id, title=final_title)
        logger.info("제목 생성 완료 [session=%d]: %s", session_id, final_title)
    except Exception as e:
        logger.warning("제목 생성 실패 [session=%d], fallback 사용: %s", session_id, e)
        update_session(session_id, title=fallback_title)