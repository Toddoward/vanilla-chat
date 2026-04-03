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


def preprocess_for_vlm(image_b64: str, resize: bool = False, max_size: int = 512) -> str:
    """
    VLM 입력 이미지 전처리 — 메모리 버퍼 전용, 원본 무결성 유지.

    1. 알파 채널 처리: 비투명 픽셀 평균 밝기로 배경색 자동 결정
       - 밝은 콘텐츠 → 어두운 배경(#1E1E1E)
       - 어두운 콘텐츠 → 밝은 배경(#DCDCDC)
    2. 리사이즈 (선택적): 장변 기준 max_size로 비율 유지 축소 후 JPEG 압축

    G-1: Phase 7-G 구현
    """
    import io, base64
    try:
        from PIL import Image
    except ImportError:
        logger.warning("Pillow 미설치 — 이미지 전처리 생략")
        return image_b64

    try:
        raw = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(raw))

        # 알파 채널 처리
        if img.mode in ("RGBA", "LA", "P"):
            if img.mode == "P":
                img = img.convert("RGBA")
            elif img.mode == "LA":
                img = img.convert("RGBA")

            alpha = img.split()[-1]
            rgb_img = img.convert("RGB")
            pixels = list(rgb_img.getdata())
            alphas = list(alpha.getdata())

            # 비투명 픽셀(alpha > 10)의 평균 밝기 계산
            visible = [sum(px) / 3 for px, a in zip(pixels, alphas) if a > 10]
            if visible:
                avg_brightness = sum(visible) / len(visible)
                bg_color = (30, 30, 30) if avg_brightness > 128 else (220, 220, 220)
            else:
                bg_color = (128, 128, 128)

            bg = Image.new("RGB", img.size, bg_color)
            bg.paste(rgb_img, mask=alpha)
            img = bg
        else:
            img = img.convert("RGB")

        # 리사이즈 (선택적)
        if resize:
            w, h = img.size
            if max(w, h) > max_size:
                ratio = max_size / max(w, h)
                img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode()

    except Exception as e:
        logger.warning("이미지 전처리 실패 — 원본 사용: %s", e)
        return image_b64


def _parse_capabilities(show_data: dict) -> dict:
    """
    Ollama /api/show 응답에서 capabilities + 모델 계열 파싱.
    반환: { "thinking": bool, "vision": bool, "tools": bool, "model_family": str }
    """
    caps_list = show_data.get("capabilities", [])
    caps_set = {c.lower() for c in caps_list}

    # G-7: 모델 계열 감지 — modelfile/template에서 추출
    model_family = "generic"
    modelfile = show_data.get("modelfile", "").lower()
    template  = show_data.get("template", "").lower()
    combined  = modelfile + template
    if "gemma" in combined:
        model_family = "gemma"
    elif "qwen" in combined:
        model_family = "qwen"
    elif "llava" in combined or "llama" in combined:
        model_family = "llava"
    elif "mistral" in combined:
        model_family = "mistral"

    return {
        "thinking":     "thinking" in caps_set,
        "vision":       "vision"   in caps_set,
        "tools":        "tools"    in caps_set,
        "model_family": model_family,
    }


# ──────────────────────────────────────────
# 추상 인터페이스
# ──────────────────────────────────────────

class BaseProvider(ABC):

    @abstractmethod
    async def chat(self, messages: list[dict], stream: bool = True, think: bool = True, inference_config: dict | None = None) -> AsyncGenerator[str, None]:
        """텍스트 생성. stream=True 시 토큰 단위로 yield.
        think: inference_config 기반으로 활성화. 모델 capabilities에 따라 조건부 전달됨."""
        ...

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """텍스트 임베딩 벡터 반환."""
        ...

    @abstractmethod
    async def vision(self, image_b64: str, prompt: str, resize: bool = False, max_size: int = 512) -> str:
        """이미지 분석 (VLM). base64 인코딩 이미지 입력."""
        ...

    @abstractmethod
    async def rerank(self, query: str, documents: list[str]) -> list[float]:
        """RAG 결과 재순위. 각 문서의 relevance score 반환."""
        ...


# ──────────────────────────────────────────
# Ollama Provider
# ──────────────────────────────────────────

# 공통 파라미터 — 거의 모든 Ollama 모델이 지원하는 options 키
COMMON_OPTIONS = {
    "temperature", "num_predict", "top_p", "repeat_penalty",
    "top_k", "seed", "tfs_z", "typical_p", "mirostat",
    "mirostat_tau", "mirostat_eta", "penalize_newline",
}


class OllamaProvider(BaseProvider):

    def __init__(self, model_name: str):
        self.model_name = model_name
        self.base_url = OLLAMA_BASE_URL
        # 모델 capabilities 캐시 — get_model_capabilities()로 채워짐
        # { "think": None | "bool" | "enum", "think_values": None | ["high","medium","low"] }
        self._capabilities: dict | None = None

    async def get_capabilities(self) -> dict:
        """Ollama /api/show에서 모델 capabilities 조회. 결과 캐싱."""
        if self._capabilities is not None:
            return self._capabilities

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{self.base_url}/api/show",
                    json={"name": self.model_name}
                )
                resp.raise_for_status()
                data = resp.json()

            caps = _parse_capabilities(data)
            self._capabilities = caps
            logger.info("모델 capabilities [%s]: %s", self.model_name, caps)
        except Exception as e:
            logger.warning("capabilities 조회 실패 [%s]: %s", self.model_name, e)
            self._capabilities = {"thinking": False, "vision": False, "tools": False}

        return self._capabilities

    async def chat(
        self,
        messages: list[dict],
        stream: bool = True,
        think: bool = True,
        inference_config: dict | None = None,
        tools: list[dict] | None = None,
    ) -> AsyncGenerator[str, None]:
        cfg = inference_config or {}

        options = {k: v for k, v in cfg.items() if k in COMMON_OPTIONS}
        options.setdefault("temperature",    0.6)
        options.setdefault("num_predict",    2048)
        options.setdefault("top_p",          0.9)
        options.setdefault("repeat_penalty", 1.1)

        payload: dict = {
            "model":    self.model_name,
            "messages": messages,
            "stream":   stream,
            "options":  options,
        }
        caps = await self.get_capabilities()
        if caps.get("thinking"):
            payload["think"] = bool(think)

        # tools 전달 — tools capability 있을 때만
        if tools and caps.get("tools"):
            payload["tools"] = tools

        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/chat",
                json=payload,
            ) as response:
                response.raise_for_status()
                import json
                thinking_started = False
                thinking_ended   = False
                async for line in response.aiter_lines():
                    if line:
                        data = json.loads(line)
                        msg = data.get("message", {})

                        thinking_chunk = msg.get("thinking", "")
                        if thinking_chunk:
                            if not thinking_started:
                                yield "<think>"
                                thinking_started = True
                            yield thinking_chunk

                        content_chunk = msg.get("content", "")
                        if content_chunk:
                            if thinking_started and not thinking_ended:
                                yield "</think>"
                                thinking_ended = True
                            yield content_chunk

                        # tool_calls 감지 — 호출자가 처리할 수 있도록 특수 토큰으로 yield
                        tool_calls = msg.get("tool_calls")
                        if tool_calls:
                            yield "\x00TOOL_CALLS\x00" + json.dumps(tool_calls)

                        if data.get("done"):
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

    async def vision(self, image_b64: str, prompt: str, resize: bool = False, max_size: int = 512) -> str:
        # G-1: 이미지 전처리 (알파 채널 + 선택적 리사이즈)
        processed_b64 = preprocess_for_vlm(image_b64, resize=resize, max_size=max_size)

        # H-7: 이미지 해상도(픽셀 수) 기반 능동적 타임아웃
        # 파일 크기 기반은 리사이즈 시 오히려 타임아웃이 짧아지는 역효과 발생
        # Ollama VLM 추론 시간은 파일 크기가 아닌 실제 픽셀 수에 비례
        try:
            import io as _io, base64 as _b64
            from PIL import Image as _Image
            _raw = _b64.b64decode(processed_b64)
            _img = _Image.open(_io.BytesIO(_raw))
            pixel_count = _img.width * _img.height
        except Exception:
            pixel_count = 512 * 512  # fallback

        if pixel_count <= 256 * 256:
            timeout = 200
        elif pixel_count <= 512 * 512:
            timeout = 400
        elif pixel_count <= 1024 * 1024:
            timeout = 600
        else:
            timeout = 720

        # G-7: 모델 계열별 메시지 포맷 분기
        caps = await self.get_capabilities()
        family = caps.get("model_family", "generic")

        # 현재 Ollama /api/chat의 images 필드는 대부분 모델에서 공통 지원
        # gemma3/qwen3.5/llava 모두 {"role":"user","content":prompt,"images":[b64]} 포맷 사용
        # 향후 다른 포맷이 필요한 모델 추가 시 여기서 분기
        if family in ("gemma", "qwen", "llava", "mistral", "generic"):
            messages = [{"role": "user", "content": prompt, "images": [processed_b64]}]
        else:
            # 알 수 없는 계열 — 동일 포맷 시도
            messages = [{"role": "user", "content": prompt, "images": [processed_b64]}]

        result = []
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model_name,
                    "messages": messages,
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
        self._slots: dict[str, str] = {}
        self._vision_supported: dict[str, bool] = {}
        self.context_length: int = 4096
        self.is_connected: bool = False

    def init(self, config: dict) -> None:
        """앱 시작 시 config를 받아 슬롯 초기화."""
        models_cfg = config.get("models", {})
        self._slots = {
            "orchestrator": models_cfg.get("orchestrator", ""),
            "response":     models_cfg.get("response",     "qwen3.5"),
            "vision":       models_cfg.get("vision",       "qwen3.5"),
            "embedding":    models_cfg.get("embedding",    "bge-m3"),
            "reranker":     models_cfg.get("reranker",     "bge-reranker-v2-m3"),
        }

        # 동일 모델명이면 인스턴스 공유 (빈 문자열 슬롯 제외)
        unique_models = {m for m in self._slots.values() if m}
        for model_name in unique_models:
            self._providers[model_name] = OllamaProvider(model_name)

        logger.info("모델 슬롯 초기화: %s", self._slots)

    def get(self, slot: str) -> "BaseProvider | None":
        model_name = self._slots.get(slot, "")
        if not model_name:
            return None
        return self._providers.get(model_name)

    async def get_orchestrator(self) -> "BaseProvider | None":
        """
        오케스트레이터 provider 반환.
        tools capability 없으면 None (이중 검증).
        """
        provider = self.get("orchestrator")
        if provider is None:
            return None
        try:
            caps = await provider.get_capabilities()
            if not caps.get("tools"):
                logger.warning(
                    "오케스트레이터 모델 '%s'에 tools capability 없음 → fallback",
                    self._slots.get("orchestrator")
                )
                return None
        except Exception as e:
            logger.warning("오케스트레이터 capability 조회 실패: %s", e)
            return None
        return provider

    @property
    def response_model_name(self) -> str:
        return self._slots.get("response", "unknown")

    @property
    def orchestrator_model_name(self) -> str:
        return self._slots.get("orchestrator", "")

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


async def fetch_all_capabilities() -> dict[str, dict]:
    """
    설치된 모든 모델의 capabilities를 병렬 조회하여 반환.
    반환: { "model_name": { "thinking": bool, "vision": bool, "tools": bool, "completion": bool, "embedding": bool } }
    """
    import asyncio

    model_names = await list_ollama_models()

    async def _fetch_one(name: str) -> tuple[str, dict]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{OLLAMA_BASE_URL}/api/show",
                    json={"name": name}
                )
                resp.raise_for_status()
                raw_caps = {c.lower() for c in resp.json().get("capabilities", [])}
            caps = {
                "thinking":  "thinking"  in raw_caps,
                "vision":    "vision"    in raw_caps,
                "tools":     "tools"     in raw_caps,
                "completion":"completion" in raw_caps,
                "embedding": "embedding" in raw_caps,
            }
        except Exception as e:
            logger.warning("capabilities 조회 실패 [%s]: %s", name, e)
            caps = {"thinking": False, "vision": False, "tools": False,
                    "completion": True, "embedding": False}
        return name, caps

    results = await asyncio.gather(*[_fetch_one(n) for n in model_names], return_exceptions=True)

    output = {}
    for item in results:
        if isinstance(item, Exception):
            logger.warning("capabilities 병렬 조회 예외: %s", item)
            continue
        name, caps = item
        output[name] = caps
    return output


# ──────────────────────────────────────────
# 전역 싱글톤
# ──────────────────────────────────────────

model_manager = ModelManager()