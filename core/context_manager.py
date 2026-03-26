"""
core/context_manager.py
Context Window 관리 — 토큰 추정 + 80% 도달 시 백그라운드 능동 요약 트리거
"""

import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def estimate_tokens(text: str) -> int:
    """
    토큰 수 근사 추정.
    한국어: 1토큰 ≈ 1.5~2자 → 보수적으로 1.5자/토큰 적용
    영어:  1토큰 ≈ 4자
    혼합 텍스트는 평균값 사용.
    """
    if not text:
        return 0
    korean_chars = sum(1 for c in text if '\uAC00' <= c <= '\uD7A3')
    other_chars = len(text) - korean_chars
    return int(korean_chars / 1.5 + other_chars / 4)


def estimate_messages_tokens(messages: list[dict]) -> int:
    """메시지 리스트 전체 토큰 추정."""
    total = 0
    for msg in messages:
        total += estimate_tokens(msg.get("content", ""))
        total += 4  # role + 구조 오버헤드
    return total


class ContextManager:
    """
    단일 세션의 컨텍스트 윈도우를 관리.
    - 시스템 프롬프트 고정
    - 사용자 입력 비율 적용
    - 대화 컨텍스트 80% 도달 시 능동 요약
    """

    def __init__(
        self,
        session_id: int,
        context_length: int,
        system_prompt: str,
        user_input_ratio: float = 0.20,
        summary_trigger: float = 0.80,
    ):
        self.session_id = session_id
        self.context_length = context_length
        self.system_prompt = system_prompt
        self.user_input_ratio = user_input_ratio
        self.summary_trigger = summary_trigger

        # 시스템 프롬프트 토큰
        self._system_tokens = estimate_tokens(system_prompt)

        # 사용자 입력 예약 토큰
        self._user_input_reserved = int(context_length * user_input_ratio)

        # 대화 컨텍스트 가용 토큰
        self.context_budget = (
            context_length
            - self._system_tokens
            - self._user_input_reserved
        )

        # 현재 대화 히스토리 (system 제외)
        self._history: list[dict] = []
        self._summarizing = False

        logger.info(
            "ContextManager 초기화 [session=%d] | 전체=%d | 시스템=%d | 유저예약=%d | 대화가용=%d",
            session_id, context_length, self._system_tokens,
            self._user_input_reserved, self.context_budget
        )

    def build_messages(self, user_message: str) -> list[dict]:
        """LLM에 전달할 전체 메시지 리스트 구성."""
        messages = [{"role": "system", "content": self.system_prompt}]
        messages.extend(self._history)
        messages.append({"role": "user", "content": user_message})
        return messages

    def add_exchange(self, user: str, assistant: str) -> None:
        """대화 1턴(user + assistant) 추가."""
        self._history.append({"role": "user",      "content": user})
        self._history.append({"role": "assistant", "content": assistant})

    def usage_ratio(self) -> float:
        """현재 대화 히스토리의 컨텍스트 사용률 (0.0 ~ 1.0+)."""
        used = estimate_messages_tokens(self._history)
        return used / max(self.context_budget, 1)

    def needs_summary(self) -> bool:
        return (
            not self._summarizing
            and self.usage_ratio() >= self.summary_trigger
        )

    async def summarize(self, provider) -> Optional[str]:
        """
        히스토리를 LLM으로 요약 후 단일 assistant 메시지로 압축.
        UI에 🔄 표시 트리거는 호출부에서 담당.
        """
        if self._summarizing or not self._history:
            return None

        self._summarizing = True
        try:
            history_text = "\n".join(
                f"{m['role'].upper()}: {m['content']}"
                for m in self._history
            )
            summary_prompt = (
                "다음 대화를 핵심 내용만 남겨 간결하게 요약해줘. "
                "요약본은 이후 대화의 컨텍스트로 사용돼.\n\n"
                f"{history_text}"
            )

            result = []
            async for chunk in provider.chat(
                [{"role": "user", "content": summary_prompt}], stream=True, think=False
            ):
                result.append(chunk)

            summary = "".join(result)

            # 히스토리를 요약본 단일 메시지로 교체
            self._history = [{"role": "assistant", "content": f"[대화 요약]\n{summary}"}]
            logger.info("컨텍스트 요약 완료 [session=%d]", self.session_id)
            return summary

        except Exception as e:
            logger.error("컨텍스트 요약 실패 [session=%d]: %s", self.session_id, e)
            return None
        finally:
            self._summarizing = False


# ──────────────────────────────────────────
# 세션별 ContextManager 레지스트리
# ──────────────────────────────────────────
_registry: dict[int, ContextManager] = {}


def get_context_manager(
    session_id: int,
    context_length: int,
    system_prompt: str,
    config: dict,
) -> ContextManager:
    """세션별 ContextManager 반환. 없으면 신규 생성."""
    if session_id not in _registry:
        ctx_cfg = config.get("context", {})
        _registry[session_id] = ContextManager(
            session_id=session_id,
            context_length=context_length,
            system_prompt=system_prompt,
            user_input_ratio=ctx_cfg.get("user_input_ratio", 0.20),
            summary_trigger=ctx_cfg.get("summary_trigger", 0.80),
        )
    return _registry[session_id]


def clear_context_manager(session_id: int) -> None:
    _registry.pop(session_id, None)