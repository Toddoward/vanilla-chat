"""
core/providers.py
모델 추상화 레이어 — 로컬(Ollama) / 클라우드(Optional) 통합 인터페이스
앱 시작 시 모델 슬롯 로드 및 Ollama 연결 상태 확인
"""

import logging
import httpx
from abc import ABC, abstractmethod
from typing import Optional, AsyncGenerator

logger = logging.getLogger(__name__)

OLLAMA_BASE_URL = "http://localhost:11434"


# ──────────────────────────────────────────
# 추상 인터페이스
# ──────────────────────────────────────────

class BaseProvider(ABC):

    @abstractmethod
    async def chat(self, messages: list[dict], stream: bool = True, think: bool = True) -> AsyncGenerator[str, None]:
        """텍스트 생성. stream=True 시 토큰 단위로 yield."""
        ...

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """텍스트 임베딩 벡터 반환."""
        ...

    @abstractmethod
    async def vision(self, image_b64: str, prompt: str) -> str:
        """이미지 분석 (VLM). base64 인코딩 이미지 입력."""
        ...

    @abstractmethod
    async def rerank(self, query: str, documents: list[str]) -> list[float]:
        """RAG 결과 재순위. 각 문서의 relevance score 반환."""
        ...


# ──────────────────────────────────────────
# Ollama Provider
# ──────────────────────────────────────────

class OllamaProvider(BaseProvider):

    def __init__(self, model_name: str):
        self.model_name = model_name
        self.base_url = OLLAMA_BASE_URL

    async def chat(self, messages: list[dict], stream: bool = True, think: bool = True) -> AsyncGenerator[str, None]:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model_name,
                    "messages": messages,
                    "stream": stream,
                    "think": think,        # Qwen3 thinking — 최상단 레벨
                }
            ) as response:
                response.raise_for_status()
                import json
                thinking_started = False
                thinking_ended   = False
                async for line in response.aiter_lines():
                    if line:
                        data = json.loads(line)
                        msg = data.get("message", {})

                        # thinking 필드: Ollama가 별도로 반환
                        thinking_chunk = msg.get("thinking", "")
                        if thinking_chunk:
                            if not thinking_started:
                                yield "<think>"
                                thinking_started = True
                            yield thinking_chunk

                        # thinking 종료 후 content 시작 시점에 닫기 태그 삽입
                        content_chunk = msg.get("content", "")
                        if content_chunk:
                            if thinking_started and not thinking_ended:
                                yield "</think>"
                                thinking_ended = True
                            yield content_chunk

                        if data.get("done"):
                            # done인데 thinking만 있고 content 없는 경우 닫기
                            if thinking_started and not thinking_ended:
                                yield "</think>"
                            break

    async def embed(self, text: str) -> list[float]:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self.base_url}/api/embeddings",
                json={"model": self.model_name, "prompt": text}
            )
            resp.raise_for_status()
            return resp.json()["embedding"]

    async def vision(self, image_b64: str, prompt: str) -> str:
        result = []
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model_name,
                    "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
                    "stream": True
                }
            ) as response:
                import json
                async for line in response.aiter_lines():
                    if line:
                        data = json.loads(line)
                        if content := data.get("message", {}).get("content", ""):
                            result.append(content)
        return "".join(result)

    async def rerank(self, query: str, documents: list[str]) -> list[float]:
        """BGE-Reranker는 FlagEmbedding으로 처리 (file_engine.rerank 위임)."""
        from core.file_engine import rerank as _rerank
        loop = __import__("asyncio").get_event_loop()
        return await loop.run_in_executor(None, _rerank, query, documents)


# ──────────────────────────────────────────
# 모델 슬롯 매니저 (싱글톤)
# ──────────────────────────────────────────

class ModelManager:
    """
    app_config.yaml의 모델 슬롯을 관리.
    response/vision이 동일 모델명이면 인스턴스 공유.
    """

    def __init__(self):
        self._providers: dict[str, BaseProvider] = {}
        self._slots: dict[str, str] = {}       # slot_name -> model_name
        self._vision_supported: dict[str, bool] = {}
        self.context_length: int = 4096        # Ollama /api/show에서 갱신
        self.is_connected: bool = False

    def init(self, config: dict) -> None:
        """앱 시작 시 config를 받아 슬롯 초기화."""
        models_cfg = config.get("models", {})
        self._slots = {
            "response":  models_cfg.get("response",  "qwen3.5"),
            "vision":    models_cfg.get("vision",    "qwen3.5"),
            "embedding": models_cfg.get("embedding", "bge-m3"),
            "reranker":  models_cfg.get("reranker",  "bge-reranker-v2-m3"),
        }

        # 동일 모델명이면 인스턴스 공유
        unique_models = set(self._slots.values())
        for model_name in unique_models:
            self._providers[model_name] = OllamaProvider(model_name)

        logger.info("모델 슬롯 초기화: %s", self._slots)

    def get(self, slot: str) -> BaseProvider:
        model_name = self._slots.get(slot, "qwen3.5")
        return self._providers[model_name]

    @property
    def response_model_name(self) -> str:
        return self._slots.get("response", "unknown")

    def vision_available(self) -> bool:
        return self._vision_supported.get(self._slots.get("vision", ""), True)


async def check_ollama_connection() -> tuple[bool, str]:
    """
    Ollama 서버 연결 상태 확인.
    Returns: (is_connected, model_name_or_error)
    """
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            resp.raise_for_status()
            return True, "connected"
    except Exception as e:
        logger.warning("Ollama 연결 실패: %s", e)
        return False, str(e)


async def get_model_context_length(model_name: str) -> int:
    """
    Ollama /api/show에서 모델의 context_length 읽기.
    실패 시 기본값 4096 반환.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/show",
                json={"name": model_name}
            )
            resp.raise_for_status()
            data = resp.json()
            # modelinfo 또는 parameters에서 context length 추출
            params = data.get("parameters", "")
            for line in params.splitlines():
                if "num_ctx" in line:
                    parts = line.split()
                    if len(parts) >= 2 and parts[-1].isdigit():
                        return int(parts[-1])
            return 4096
    except Exception as e:
        logger.warning("context_length 조회 실패 (%s): %s", model_name, e)
        return 4096


async def list_ollama_models() -> list[str]:
    """Ollama에서 사용 가능한 모델 목록 반환."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            resp.raise_for_status()
            models = resp.json().get("models", [])
            return [m["name"] for m in models]
    except Exception:
        return []


# ──────────────────────────────────────────
# 전역 싱글톤
# ──────────────────────────────────────────

model_manager = ModelManager()
