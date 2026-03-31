#!/usr/bin/env bash
set -e

echo ""
echo " ================================================"
echo "  🍨  Vanilla Chat — 시작 준비 중..."
echo " ================================================"
echo ""

OS="$(uname -s)"

# ─────────────────────────────────────────
# 1. Python 3.12+ 확인 및 설치
# ─────────────────────────────────────────
echo "[1/5] Python 확인 중..."

PYTHON_CMD=""
for cmd in python3.12 python3 python; do
    if command -v "$cmd" &>/dev/null; then
        VERSION=$("$cmd" --version 2>&1 | awk '{print $2}')
        MAJOR=$(echo "$VERSION" | cut -d. -f1)
        MINOR=$(echo "$VERSION" | cut -d. -f2)
        if [ "$MAJOR" -ge 3 ] && [ "$MINOR" -ge 12 ]; then
            PYTHON_CMD="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "   Python 3.12+ 가 없습니다. 설치를 시도합니다..."
    if [ "$OS" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            echo "   Homebrew 설치 중..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install python@3.12
        PYTHON_CMD="python3.12"
    elif [ "$OS" = "Linux" ]; then
        if command -v apt-get &>/dev/null; then
            sudo apt-get update -qq
            sudo apt-get install -y python3.12 python3.12-venv python3.12-pip
            PYTHON_CMD="python3.12"
        elif command -v dnf &>/dev/null; then
            sudo dnf install -y python3.12
            PYTHON_CMD="python3.12"
        else
            echo "   [오류] 지원하지 않는 Linux 배포판입니다. Python 3.12를 직접 설치해주세요."
            echo "   https://www.python.org/downloads/"
            exit 1
        fi
    fi
    echo "   Python 3.12 설치 완료."
else
    echo "   Python OK: $PYTHON_CMD ($($PYTHON_CMD --version 2>&1))"
fi

# ─────────────────────────────────────────
# 2. Ollama 확인 및 설치
# ─────────────────────────────────────────
echo "[2/5] Ollama 확인 중..."

if ! command -v ollama &>/dev/null; then
    echo "   Ollama 가 없습니다. 설치합니다..."
    if [ "$OS" = "Darwin" ]; then
        brew install ollama
    else
        curl -fsSL https://ollama.com/install.sh | sh
    fi
    echo "   Ollama 설치 완료."
else
    echo "   Ollama OK"
fi

# Ollama 서버 실행 확인
if ! ollama list &>/dev/null 2>&1; then
    echo "   Ollama 서버를 백그라운드에서 시작합니다..."
    ollama serve &>/dev/null &
    sleep 3
fi

# ─────────────────────────────────────────
# 3. 가상환경 및 의존성
# ─────────────────────────────────────────
echo "[3/5] Python 환경 준비 중..."

if [ ! -d "venv" ]; then
    echo "   가상환경 생성 중..."
    "$PYTHON_CMD" -m venv venv
fi

# shellcheck disable=SC1091
source venv/bin/activate

pip install -q -r requirements.txt
echo "   의존성 설치 완료."

# ─────────────────────────────────────────
# 4. app_config.yaml에서 모델 pull
# ─────────────────────────────────────────
echo "[4/5] 모델 확인 및 다운로드 중..."

python3 - <<'EOF'
import yaml, subprocess, sys

try:
    with open('app_config.yaml', encoding='utf-8') as f:
        cfg = yaml.safe_load(f)
    models = cfg.get('models', {})
    seen = set()
    for slot, name in models.items():
        if not name or name in seen:
            continue
        seen.add(name)
        if 'FlagEmbedding' in name:
            continue
        if slot in ('embedding', 'reranker') and 'bge' in name.lower():
            continue
        print(f'  pulling {name} ...')
        result = subprocess.run(['ollama', 'pull', name])
        if result.returncode != 0:
            print(f'  [경고] {name} pull 실패 — 나중에 수동으로 실행하세요.')
except Exception as e:
    print(f'  [경고] 모델 확인 실패: {e}')
EOF

echo "   모델 준비 완료."

# ─────────────────────────────────────────
# 5. 앱 실행
# ─────────────────────────────────────────
echo "[5/5] Vanilla Chat 시작..."
echo ""
echo " ================================================"
echo "  🍨  http://localhost:8000 에서 접속하세요"
echo "  종료하려면 Ctrl+C 를 누르세요"
echo " ================================================"
echo ""

uvicorn app:app --reload --host 0.0.0.0 --port 8000