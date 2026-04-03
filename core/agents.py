"""
core/agents.py — Re-Act 기반 에이전틱 워크플로우 (Phase 7-E)
- TOOLS 정의
- run_orchestrator_loop(): 오케스트레이터(0.8b) 루프
- execute_tool(): 도구 실행
- analyze_images(): VLM 직접 분석 (fallback용)
- is_image(): 이미지 파일 여부
"""
import json
import logging
import asyncio
from pathlib import Path

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
TOOL_CALL_PREFIX = "\x00TOOL_CALLS\x00"
MAX_TOOL_CALLS   = 3  # 무한루프 방지


def is_image(filename: str) -> bool:
    return Path(filename).suffix.lower() in IMAGE_EXTENSIONS


# ──────────────────────────────────────
# 도구 정의
# ──────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "rag_search",
            "description": (
                "Search registered documents for content related to the user's question. "
                "Use when the user asks about the CONTENTS of stored files or data. "
                "Always use a meaningful content-based query, NOT a filename."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Content-based search query (not a filename)"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": (
                "List all registered files in local Storage. "
                "Use when the user asks what files are saved, registered, or available. "
                "Optionally filter by keyword. Do NOT use this to search file contents — use rag_search for that."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "Optional keyword to filter files by name or type (e.g. 'pdf', '약관')"
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_image",
            "description": (
                "Analyze one or more attached images using a Vision model. "
                "Use when the user wants to understand, describe, or extract text from images. "
                "Pass ALL attached image filenames at once."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filenames": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of image filenames to analyze. Include all attached images."
                    }
                },
                "required": ["filenames"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "store_file",
            "description": (
                "Save and register an attached file into local Storage for future search. "
                "Use when the user wants to save, register, or store a file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "Filename of the file to store"
                    }
                },
                "required": ["filename"]
            }
        }
    },
]


# ──────────────────────────────────────
# 도구 실행
# ──────────────────────────────────────

async def execute_tool(
    name: str,
    args: dict,
    images_b64: list[dict],
    upload_paths: list[dict],
    vision_provider,
    user_message: str,
    config: dict,
) -> dict:
    """
    도구 이름과 인자를 받아 실행하고 결과 dict 반환.
    반환: { "tool": str, "result": str, "status": "ok" | "error" }
    """
    try:
        if name == "list_files":
            from core.database import get_all_file_links
            keyword = args.get("keyword", "").strip().lower()
            files = get_all_file_links()
            if keyword:
                files = [f for f in files if keyword in (f.get("display_name") or "").lower()]
            if not files:
                msg = f"'{keyword}' 관련 파일이 없습니다." if keyword else "등록된 파일이 없습니다."
                return {"tool": name, "result": msg, "status": "ok", "files": []}
            lines = [
                f"- {f.get('display_name', '?')} ({f.get('file_type', '?')}, {f.get('embedding_status', '?')})"
                for f in files
            ]
            result = f"등록된 파일 {len(files)}개:\n" + "\n".join(lines)
            # 파일 뱃지용 메타데이터
            files_meta = [
                {
                    "name":   f.get("display_name") or f.get("original_path", "?"),
                    "file_id": f.get("id"),
                    "file_type": f.get("file_type", ""),
                    "status": f.get("embedding_status", ""),
                }
                for f in files
            ]
            return {"tool": name, "result": result, "status": "ok", "files": files_meta}

        elif name == "rag_search":
            from core.database import hybrid_search
            from core.file_engine import embed_chunks, rerank
            query  = args.get("query", user_message)
            top_k  = config.get("rag", {}).get("top_k", 5)
            query_vec = None
            try:
                vecs = embed_chunks([query])
                if vecs:
                    query_vec = vecs[0]
            except Exception as e:
                logger.warning("쿼리 임베딩 실패 — FTS만 사용: %s", e)

            # top_k * 3개를 가져와서 리랭킹 후 top_k로 압축
            candidates = hybrid_search(query, query_vec, top_k=top_k * 3)
            if not candidates:
                return {"tool": name, "result": "관련 문서를 찾지 못했습니다.", "status": "ok", "sources": []}

            # 리랭킹 적용
            try:
                docs = [r.get("content", "") for r in candidates]
                scores = rerank(query, docs)
                ranked = sorted(
                    zip(scores, candidates),
                    key=lambda x: x[0],
                    reverse=True
                )
                results = [r for s, r in ranked[:top_k] if s >= 0.3]
                if not results:
                    results = [r for _, r in ranked[:top_k]]
                logger.info("리랭킹 완료: %d→%d개 (임계값 0.3)", len(candidates), len(results))
            except Exception as e:
                logger.warning("리랭킹 실패 — 원본 결과 사용: %s", e)
                results = candidates[:top_k]

            formatted = "\n\n".join(
                f"[{r.get('source_name', r.get('display_name', '문서'))}]\n{r.get('content', '')}"
                for r in results
            )
            seen = set()
            sources = []
            for r in results:
                name_key = r.get("source_name") or r.get("display_name") or ""
                path_key = r.get("source_path") or r.get("original_path") or ""
                file_id  = r.get("file_id")
                if name_key not in seen:
                    seen.add(name_key)
                    sources.append({"name": name_key, "path": path_key, "file_id": file_id})
            return {"tool": name, "result": formatted, "status": "ok", "sources": sources}

        elif name == "analyze_image":
            if vision_provider is None:
                return {"tool": name, "result": "시각 모델이 설정되지 않았습니다.", "status": "error"}

            # G-4: filenames 배열 수용 (하위 호환: filename 단일값도 처리)
            filenames = args.get("filenames") or ([args["filename"]] if args.get("filename") else [])
            if not filenames:
                filenames = [img["name"] for img in images_b64] if images_b64 else []
            if not filenames:
                return {"tool": name, "result": "분석할 이미지를 찾지 못했습니다.", "status": "error"}

            vis_cfg = config.get("vision", {}).get("preprocess", {})
            prompt = (
                f"사용자 요청: {user_message}\n\n"
                "이 이미지를 분석하고 내용을 설명해주세요. "
                "텍스트가 있다면 모두 추출해주세요."
            )

            # G-5: 복수 이미지 순차 처리 → 결과 통합
            results = []
            for fname in filenames:
                img = next((i for i in images_b64 if i.get("name") == fname), None)
                if img is None and len(filenames) == 1 and images_b64:
                    img = images_b64[0]
                if img is None:
                    results.append(f"[{fname}] 이미지를 찾지 못했습니다.")
                    continue
                try:
                    result = await vision_provider.vision(
                        img["data"], prompt,
                        resize=vis_cfg.get("resize", False),
                        max_size=vis_cfg.get("max_size", 512),
                    )
                    results.append(f"[{fname}]\n{result.strip()}")
                except Exception as e:
                    # 타임아웃 시 Ollama 서버는 계속 처리 중 — 오케스트레이터 재시도로 자연스럽게 해결됨
                    logger.warning("VLM 분석 실패 [%s]: %s", fname, e)
                    results.append(f"[{fname}] 이미지 분석에 실패했습니다. 다시 시도합니다.")
                    # H-2: status를 error로 반환해서 오케스트레이터가 실패를 명확히 인식
                    combined = "\n\n".join(results)
                    return {"tool": name, "result": combined, "status": "error"}

            combined = "\n\n".join(results)
            return {"tool": name, "result": combined, "status": "ok"}

        elif name == "store_file":
            filename = args.get("filename", "")
            up = next((u for u in upload_paths if u.get("name") == filename), None)
            if up is None and upload_paths:
                up = upload_paths[0]

            files_dir = Path("storage/files")
            files_dir.mkdir(parents=True, exist_ok=True)

            if up is not None:
                # 비이미지 파일 경로: uploads_tmp → storage/files/ 이동
                import shutil as _shutil
                permanent_path = files_dir / up["name"]
                try:
                    _shutil.move(up["tmp_path"], str(permanent_path))
                except Exception as e:
                    logger.warning("파일 이동 실패 [%s → %s]: %s", up["tmp_path"], permanent_path, e)
                    return {"tool": name, "result": f"파일 이동 실패: {e}", "status": "error"}
                save_name = up["name"]
                save_path = str(permanent_path)

            else:
                # 이미지 파일 경로: images_b64 base64 → storage/files/ 디코딩 저장
                img = next((i for i in images_b64 if i.get("name") == filename), None)
                if img is None and images_b64:
                    img = images_b64[0]
                if img is None:
                    return {"tool": name, "result": "저장할 파일을 찾지 못했습니다.", "status": "error"}
                import base64 as _b64
                permanent_path = files_dir / img["name"]
                try:
                    with open(permanent_path, "wb") as _f:
                        _f.write(_b64.b64decode(img["data"]))
                except Exception as e:
                    logger.warning("이미지 저장 실패: %s", e)
                    return {"tool": name, "result": f"이미지 저장 실패: {e}", "status": "error"}
                save_name = img["name"]
                save_path = str(permanent_path)

            from core.file_engine import register_file
            reg_result = await register_file(save_path, save_name, config)
            return {
                "tool": name,
                "result": f"'{save_name}' 파일이 Storage에 등록됐습니다. 이제 검색이 가능합니다.",
                "status": "ok"
            }

        else:
            return {"tool": name, "result": f"알 수 없는 도구: {name}", "status": "error"}

    except Exception as e:
        logger.warning("도구 실행 실패 [%s]: %s", name, e)
        return {"tool": name, "result": f"도구 실행 오류: {e}", "status": "error"}


# ──────────────────────────────────────
# 오케스트레이터 루프
# ──────────────────────────────────────

async def run_orchestrator_loop(
    orchestrator,
    messages: list[dict],
    images_b64: list[dict],
    upload_paths: list[dict],
    vision_provider,
    user_message: str,
    config: dict,
):
    """
    오케스트레이터(0.8b)를 통해 도구 선택 → 실행 루프.
    H-1: async generator로 전환 — SSE agent 이벤트를 루프 내에서 직접 yield.
    yield 패턴:
      - ("event", {"type": "agent", "agent": ...})  ← SSE 이벤트
      - ("result", tool_results)                     ← 최종 결과 (마지막 yield)
    """
    ORCHESTRATOR_SYSTEM = (
        "You are a routing assistant. Your only job is to decide which tools to call.\n"
        "Do NOT answer the user's question yourself.\n\n"
        "Tool usage rules:\n"
        "- list_files: Call this when the user asks what files are saved, registered, or available. "
        "Use optional keyword to filter. Example: 'what files do I have?', '등록된 파일 보여줘', 'pdf 파일 있어?'\n"
        "- rag_search: Call this when the user asks about the CONTENTS of stored documents. "
        "Always use a meaningful CONTENT-BASED query — never use a filename as the query. "
        "Example query: '해지 조건', '금리 관련 내용', not 'document.pdf'\n"
        "- analyze_image: Call this when images are attached AND the user wants to understand, describe, or extract text. "
        "Pass ALL attached image filenames in the filenames array at once — do NOT call this multiple times for multiple images.\n"
        "- store_file: Call this when a file is attached AND the user wants to save or register it for later search.\n"
        "- If none of the above apply, do not call any tool.\n\n"
        "Do NOT call rag_search for:\n"
        "- Questions about the current conversation ('what did you just say?', '방금 한 말이 뭐야?')\n"
        "- General knowledge questions that don't require stored documents\n"
        "- Simple tasks like translation, summarization of the above response, math, coding\n\n"
        "Retry rules:\n"
        "- If a tool returns a failure message (e.g. '분석에 실패했습니다', 'failed', 'error'), "
        "call the same tool ONE more time before giving up. Do not proceed to response generation on first failure.\n\n"
        "Call tools immediately without explanation. Do not think or reason before deciding."
    )

    tool_results = []
    consecutive_failures = {}

    loop_messages = [{"role": "system", "content": ORCHESTRATOR_SYSTEM}]

    last_user = user_message
    context_hint = ""
    if images_b64:
        names = ", ".join(i["name"] for i in images_b64)
        context_hint += f"\n[Attached images: {names}]"
    if upload_paths:
        names = ", ".join(u["name"] for u in upload_paths)
        context_hint += f"\n[Attached files: {names}]"

    loop_messages.append({
        "role": "user",
        "content": last_user + context_hint
    })

    for _ in range(MAX_TOOL_CALLS):
        raw_chunks = []
        tool_calls_raw = None
        async for chunk in orchestrator.chat(
            loop_messages,
            stream=True,
            think=False,
            inference_config={"temperature": 0.1, "num_predict": 256},
            tools=TOOLS,
        ):
            if chunk.startswith(TOOL_CALL_PREFIX):
                tool_calls_raw = chunk[len(TOOL_CALL_PREFIX):]
            else:
                raw_chunks.append(chunk)

        if not tool_calls_raw:
            logger.info("오케스트레이터: 도구 호출 없음 → Stage 2 진행")
            break

        try:
            tool_calls = json.loads(tool_calls_raw)
        except Exception as e:
            logger.warning("tool_calls 파싱 실패: %s | raw: %s", e, tool_calls_raw)
            break

        if not tool_calls:
            logger.info("오케스트레이터: 빈 tool_calls → Stage 2 진행")
            break

        loop_messages.append({
            "role": "assistant",
            "content": "".join(raw_chunks),
            "tool_calls": tool_calls,
        })

        for tc in tool_calls:
            fn   = tc.get("function", {})
            name = fn.get("name", "")
            try:
                args = fn.get("arguments", {})
                if isinstance(args, str):
                    args = json.loads(args)
            except Exception:
                args = {}

            # H-1: 도구 실행 직전 SSE agent 이벤트 yield (인디케이터 타이밍 개선)
            agent_label = {
                "rag_search":    "rag",
                "list_files":    "list_files",
                "analyze_image": "vision",
                "store_file":    "store",
            }.get(name, name)
            yield ("event", {"type": "agent", "agent": agent_label})

            logger.info("도구 실행: %s %s", name, args)
            result = await execute_tool(
                name, args, images_b64, upload_paths,
                vision_provider, user_message, config
            )
            tool_results.append(result)

            # H-3: 도구별 연속 실패 횟수 추적 → 2회 연속 실패 시 루프 조기 종료
            if result.get("status") == "error":
                consecutive_failures[name] = consecutive_failures.get(name, 0) + 1
                if consecutive_failures[name] >= 2:
                    logger.warning("도구 연속 실패 2회 [%s] → 루프 조기 종료", name)
                    loop_messages.append({
                        "role": "tool",
                        "content": result["result"],
                    })
                    yield ("result", tool_results)
                    return
            else:
                consecutive_failures[name] = 0

            loop_messages.append({
                "role": "tool",
                "content": result["result"],
            })

    yield ("result", tool_results)


# ──────────────────────────────────────
# Fallback: VLM 직접 분석 (오케스트레이터 없을 때)
# ──────────────────────────────────────

async def analyze_images(
    vision_provider,
    images_b64: list[dict],
    user_message: str,
    config: dict | None = None,
) -> str:
    """오케스트레이터 없을 때 이미지를 직접 VLM 분석."""
    if not images_b64 or vision_provider is None:
        return ""
    prompt = (
        f"사용자 요청: {user_message}\n\n"
        "이 이미지를 분석하고 내용을 설명해주세요. "
        "텍스트가 있다면 모두 추출해주세요."
    )
    vis_cfg = (config or {}).get("vision", {}).get("preprocess", {})
    results = []
    for img in images_b64:
        name = img.get("name", "image")
        data = img.get("data", "")
        if not data:
            continue
        try:
            result = await vision_provider.vision(
                data, prompt,
                resize=vis_cfg.get("resize", False),
                max_size=vis_cfg.get("max_size", 512),
            )
            results.append(f"[{name}]\n{result.strip()}")
        except Exception as e:
            logger.warning("VLM 분석 실패 [%s]: %s", name, e)
    if not results:
        return ""
    return "[이미지 분석 결과]\n" + "\n\n".join(results)