<div align="center">

![Vanilla Chat Logo](static/images/logo_color.png)

  <h1>Vanilla Chat 🍨</h1>
  <p><strong>Zero-config 로컬 AI 챗봇 — 설치하면 즉시 동작, 원하는 만큼 확장</strong></p>

  <!-- 개요 GIF 자리 -->
  <p><em>[자신만의 이름·로고·색상으로 커스터마이징된 Vanilla Chat이 RAG 검색, 이미지 분석, 파일 저장 등 다양한 Task를 수행하는 GIF]</em></p>

  <p>
    <img alt="Python" src="https://img.shields.io/badge/Python-3.12-3776ab?logo=python&logoColor=white"/>
    <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white"/>
    <img alt="Ollama" src="https://img.shields.io/badge/Ollama-Local_LLM-black?logo=ollama"/>
    <img alt="SQLite" src="https://img.shields.io/badge/SQLite-FTS5+Vec-003b57?logo=sqlite"/>
    <img alt="License" src="https://img.shields.io/badge/License-MIT-green"/>
  </p>
</div>

---

## 개요

**Vanilla Chat**은 인터넷 연결 없이 내 컴퓨터에서 완전히 동작하는 개인용 AI 챗봇입니다.

- **Zero-config**: 설치 후 아무 설정 없이 즉시 동작
- **완전 로컬**: 대화 내용, 문서, 파일이 외부 서버로 전송되지 않음
- **에이전틱 워크플로우**: 질문 의도에 따라 문서 검색, 이미지 분석, 파일 저장을 자동 수행
- **커스터마이징**: 앱 이름, 로고, 색상, 모델, 시스템 프롬프트를 UI에서 직접 변경

---

## 주요 기능

### 💬 채팅
- 로컬 LLM과 실시간 스트리밍 대화
- Chain-of-Thought 추론 패널 (추론 과정 접기/펼치기)
- 응답 재생성, 대화 제목 자동 생성 및 인라인 수정
- 응답 중단 시 지금까지 내용 자동 저장

<!-- [Vanilla Chat 채팅 화면 — 스트리밍 응답 + 추론 패널] -->

### 🔍 RAG (Retrieval-Augmented Generation)
- 등록된 문서를 자동 검색하여 응답에 반영
- BGE-M3 Dense 벡터 + FTS5 키워드 하이브리드 검색
- BGE-Reranker-v2-M3로 최종 연관성 정밀 필터링
- 출처 문서 버블 하단에 표시, 클릭 시 파일 열람

<!-- [RAG 검색 결과 + 출처 표시 화면] -->

### 👁️ VLM 이미지 분석
- 이미지 파일 첨부 시 Vision 모델이 내용 자동 분석
- OCR, 이미지 설명, 도표 해석 등 지원
- 분석 결과를 RAG 컨텍스트와 함께 응답에 반영

### 💾 Data Hub
- PDF, DOCX, TXT, MD 파일 업로드 → 자동 임베딩 등록
- 등록 파일 상태 관리 (임베딩 진행률, 경로 끊김 감지)
- 파일 클릭 시 OS 기본 앱으로 즉시 열람
- 임베딩 모델 교체 시 차원 불일치 감지 + 재임베딩

<!-- [Data Hub 파일 목록 화면] -->

### 🤖 2-Stage 에이전틱 워크플로우
- **Stage 1 (오케스트레이터)**: 소형 모델이 질문 의도 파악 후 도구 선택
- **Stage 2 (응답 생성)**: 도구 결과를 컨텍스트로 받아 최종 응답 생성
- 지원 도구: `rag_search`, `analyze_image`, `store_file`
- 오케스트레이터 없이도 fallback 동작 보장

### ⚙️ Settings UI
- 모델 슬롯별 설정 (오케스트레이터, 응답, 시각, 임베딩, 리랭커)
- Ollama capabilities 기반 필터링 (tools/vision 없는 모델 자동 제외)
- 추론 파라미터 실시간 조절 (temperature, top_p 등)
- 앱 이름, 로고, 색상 테마, 시스템 프롬프트 커스터마이징

<!-- [Settings 화면] -->

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| Backend | FastAPI + Python 3.12 |
| Frontend | Vanilla JS ES6 Modules (프레임워크 없음) |
| DB | SQLite (FTS5 전문 검색 + sqlite-vec 벡터 검색) |
| LLM 런타임 | Ollama |
| 기본 모델 구성 | qwen3.5:0.8b (오케스트레이터) · gemma3:4b (응답+시각) |
| 임베딩 | BGE-M3 (FlagEmbedding) |
| 리랭커 | BGE-Reranker-v2-M3 (FlagEmbedding) |

---

## 요구 사항

- Python 3.12+
- [Ollama](https://ollama.com) 설치 및 실행 중
- 권장 RAM: 8GB 이상 (모델 크기에 따라 다름)

---

## 빠른 시작 (원클릭)

Python, Ollama, 모델 다운로드, 앱 실행까지 자동으로 처리합니다.

**Windows**
```
start.bat 더블클릭
```

**macOS / Linux**
```bash
chmod +x start.sh
./start.sh
```

스크립트가 자동으로 수행하는 작업:
1. Python 3.12+ 확인 및 설치 (없을 시 winget/brew/apt 사용)
2. Ollama 확인 및 설치
3. 가상환경 생성 및 의존성 설치
4. `app_config.yaml`에 설정된 모델 자동 pull
5. `http://localhost:8000` 에서 앱 시작

---

## 설치 방법

### 1. 저장소 클론

```bash
git clone https://github.com/your-username/vanilla-chat.git
cd vanilla-chat
```

### 2. 가상환경 생성 및 활성화

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python -m venv venv
source venv/bin/activate
```

### 3. 의존성 설치

```bash
pip install -r requirements.txt
```

> **주의:** FlagEmbedding과의 호환성을 위해 `transformers==4.44.2`가 고정되어 있습니다.

### 4. Ollama 모델 다운로드

```bash
# 기본 구성 (권장)
ollama pull qwen3.5:0.8b    # 오케스트레이터
ollama pull gemma3:4b        # 응답 + 시각
ollama pull bge-m3           # 임베딩
ollama pull qllama/bge-reranker-v2-m3  # 리랭커
```

### 5. 실행

```bash
uvicorn app:app --reload
```

브라우저에서 `http://localhost:8000` 접속

---

## 모델 슬롯 구성

`app_config.yaml`에서 모델을 교체할 수 있습니다. Settings UI에서도 실시간 변경이 가능합니다.

```yaml
models:
  orchestrator: qwen3.5:0.8b   # tools capability 필수
  response: gemma3:4b
  vision: gemma3:4b             # response와 동일하면 인스턴스 공유
  embedding: bge-m3
  reranker: qllama\bge-reranker-v2-m3
```

| 슬롯 | 역할 | 필수 Capability |
|---|---|---|
| `orchestrator` | 도구 선택 라우팅 | `tools` |
| `response` | 최종 응답 생성 | `completion` |
| `vision` | 이미지 분석 | `vision` |
| `embedding` | 문서 벡터화 | `embedding` |
| `reranker` | 검색 결과 재순위 | — |

---

## 프로젝트 구조

```
vanilla-chat/
├── app.py                  # FastAPI 진입점
├── app_config.yaml         # 통합 설정
├── theme_config.json       # UI 테마
├── requirements.txt
│
├── core/
│   ├── agents.py           # 에이전틱 워크플로우, 도구 정의
│   ├── database.py         # SQLite, FTS5, sqlite-vec
│   ├── file_engine.py      # 파일 처리, 임베딩, 경로 검증
│   ├── providers.py        # 모델 슬롯 매니저, Ollama 연동
│   └── context_manager.py  # 컨텍스트 윈도우 관리, 능동 요약
│
├── static/
│   ├── css/
│   ├── images/
│   └── js/
│       ├── app.js          # SPA 라우터
│       ├── chat.js         # 채팅 UI, 스트리밍
│       ├── datahub.js      # Data Hub
│       ├── settings.js     # Settings
│       ├── chatlist.js     # 채팅 목록
│       └── search.js       # 통합 검색
│
├── templates/
│   └── index.html
│
└── storage/
    ├── db/                 # SQLite DB
    └── uploads_tmp/        # 업로드 임시 공간
```

---

## 커스터마이징

### 앱 이름 · 로고 변경

Settings → 🎨 앱 외관 섹션에서 변경하거나 `app_config.yaml`을 직접 수정합니다.

```yaml
app:
  name: My Assistant
  logo: static/images/my_logo.png
  logo_emoji_fallback: 🤖
```

### 시스템 프롬프트 변경

Settings → 💬 시스템 프롬프트 섹션에서 변경합니다. `$(name)` 은 앱 이름으로 자동 치환됩니다.

### 색상 테마 변경

`theme_config.json`에서 CSS 변수를 수정합니다.

```json
{
  "theme": "dark",
  "colors": {
    "--accent": "#your-color"
  }
}
```

---

## 지원 파일 형식

| 형식 | 텍스트 추출 | RAG 검색 |
|---|---|---|
| `.txt`, `.md` | ✅ | ✅ |
| `.pdf` | ✅ (pymupdf) | ✅ |
| `.docx` | ✅ (python-docx) | ✅ |
| `.png`, `.jpg`, `.jpeg`, `.webp` | VLM 분석 | 예정 |

---

## 라이선스

MIT License

---

<div align="center">
  <sub>Made with 🍨 by Vanilla Chat</sub>
</div>