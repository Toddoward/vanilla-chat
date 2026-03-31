@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Vanilla Chat 🍨

echo.
echo  ================================================
echo   🍨  Vanilla Chat — 시작 준비 중...
echo  ================================================
echo.

:: ─────────────────────────────────────────
:: 1. Python 3.12+ 확인 및 설치
:: ─────────────────────────────────────────
echo [1/5] Python 확인 중...

set PYTHON_OK=0
for %%C in (python python3) do (
    %%C --version >nul 2>&1
    if !errorlevel! == 0 (
        for /f "tokens=2 delims= " %%V in ('%%C --version 2^>^&1') do (
            for /f "tokens=1,2 delims=." %%M in ("%%V") do (
                if %%M geq 3 if %%N geq 12 (
                    set PYTHON_CMD=%%C
                    set PYTHON_OK=1
                )
            )
        )
    )
)

if !PYTHON_OK! == 0 (
    echo    Python 3.12+ 가 없습니다. winget으로 설치합니다...
    winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    if !errorlevel! neq 0 (
        echo.
        echo    [오류] Python 설치에 실패했습니다.
        echo    https://www.python.org/downloads/ 에서 직접 설치 후 다시 실행해주세요.
        pause
        exit /b 1
    )
    set PYTHON_CMD=python
    echo    Python 3.12 설치 완료.
) else (
    echo    Python OK: !PYTHON_CMD!
)

:: ─────────────────────────────────────────
:: 2. Ollama 확인 및 설치
:: ─────────────────────────────────────────
echo [2/5] Ollama 확인 중...

ollama --version >nul 2>&1
if !errorlevel! neq 0 (
    echo    Ollama 가 없습니다. winget으로 설치합니다...
    winget install --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements
    if !errorlevel! neq 0 (
        echo.
        echo    [오류] Ollama 설치에 실패했습니다.
        echo    https://ollama.com/download 에서 직접 설치 후 다시 실행해주세요.
        pause
        exit /b 1
    )
    echo    Ollama 설치 완료.
) else (
    echo    Ollama OK
)

:: Ollama 서버 시작 확인
ollama list >nul 2>&1
if !errorlevel! neq 0 (
    echo    Ollama 서버를 시작합니다...
    start "" /b ollama serve
    timeout /t 3 /nobreak >nul
)

:: ─────────────────────────────────────────
:: 3. 가상환경 및 의존성
:: ─────────────────────────────────────────
echo [3/5] Python 환경 준비 중...

if not exist "venv\" (
    echo    가상환경 생성 중...
    !PYTHON_CMD! -m venv venv
)

call venv\Scripts\activate.bat

pip install -q -r requirements.txt
if !errorlevel! neq 0 (
    echo    [오류] 의존성 설치 실패
    pause
    exit /b 1
)
echo    의존성 설치 완료.

:: ─────────────────────────────────────────
:: 4. app_config.yaml에서 모델 pull
:: ─────────────────────────────────────────
echo [4/5] 모델 확인 및 다운로드 중...

python -c "
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
        # 리랭커 FlagEmbedding 고정 항목 제외
        if 'FlagEmbedding' in name:
            continue
        # embedding/reranker 슬롯의 bge 모델은 HuggingFace에서 로드하므로 ollama pull 불필요
        if slot in ('embedding', 'reranker') and 'bge' in name.lower():
            continue
        print(f'  pulling {name} ...')
        result = subprocess.run(['ollama', 'pull', name], capture_output=False)
        if result.returncode != 0:
            print(f'  [경고] {name} pull 실패 — 나중에 수동으로 실행하세요.')
except Exception as e:
    print(f'  [경고] 모델 확인 실패: {e}')
"
echo    모델 준비 완료.

:: ─────────────────────────────────────────
:: 5. 앱 실행
:: ─────────────────────────────────────────
echo [5/5] Vanilla Chat 시작...
echo.
echo  ================================================
echo   🍨  http://localhost:8000 에서 접속하세요
echo   종료하려면 Ctrl+C 를 누르세요
echo  ================================================
echo.

uvicorn app:app --reload --host 0.0.0.0 --port 8000

pause