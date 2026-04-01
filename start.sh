#!/usr/bin/env bash

echo ""
echo " ================================================"
echo "  Vanilla Chat - Starting..."
echo " ================================================"
echo ""

OS="$(uname -s)"

# ── 1. Python 3.12+ ──────────────────────────────
echo "[1/5] Checking Python..."

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
    echo "   Python 3.12+ not found. Installing..."
    if [ "$OS" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            echo "   Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
        fi
        brew install python@3.12
        PYTHON_CMD="$(brew --prefix python@3.12)/bin/python3.12"
    elif [ "$OS" = "Linux" ]; then
        if command -v apt-get &>/dev/null; then
            sudo apt-get update -qq
            sudo apt-get install -y python3.12 python3.12-venv python3-pip
            PYTHON_CMD="python3.12"
        elif command -v dnf &>/dev/null; then
            sudo dnf install -y python3.12
            PYTHON_CMD="python3.12"
        else
            echo "   [ERROR] Unsupported distro. Install Python 3.12 manually:"
            echo "   https://www.python.org/downloads/"
            exit 1
        fi
    fi
    echo "   Python 3.12 installed."
else
    echo "   Python OK: $PYTHON_CMD ($("$PYTHON_CMD" --version 2>&1))"
fi

# ── 2. Ollama ─────────────────────────────────────
echo "[2/5] Checking Ollama..."

if ! command -v ollama &>/dev/null; then
    echo "   Ollama not found. Installing..."
    if [ "$OS" = "Darwin" ]; then
        echo "   Please download Ollama from https://ollama.com/download"
        echo "   and re-run this script after installation."
        exit 1
    else
        curl -fsSL https://ollama.com/install.sh | sh
    fi
    echo "   Ollama installed."
else
    echo "   Ollama OK"
fi

if ! ollama list &>/dev/null 2>&1; then
    echo "   Starting Ollama server in background..."
    ollama serve &>/dev/null &
    sleep 3
fi

# ── 3. venv + dependencies ────────────────────────
echo "[3/5] Setting up Python environment..."

if [ ! -d "venv" ]; then
    echo "   Creating virtualenv..."
    "$PYTHON_CMD" -m venv venv
fi

# shellcheck disable=SC1091
source venv/bin/activate

if ! pip install -q -r requirements.txt; then
    echo "   [ERROR] Dependency install failed."
    exit 1
fi
echo "   Dependencies ready."

# ── 4. Pull models ────────────────────────────────
echo "[4/5] Pulling models..."

"$PYTHON_CMD" _pull_models.py

echo "   Models ready."

# ── 5. Run app ────────────────────────────────────
echo "[5/5] Starting Vanilla Chat..."
echo ""
echo " ================================================"
echo "  Open http://localhost:8000 in your browser"
echo "  Press Ctrl+C to stop"
echo " ================================================"
echo ""

uvicorn app:app --reload --host 0.0.0.0 --port 8000