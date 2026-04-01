@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Vanilla Chat

echo.
echo  ================================================
echo   Vanilla Chat - Starting...
echo  ================================================
echo.

:: 1. Python 3.12+
echo [1/5] Checking Python...

set PYTHON_CMD=
set PYTHON_OK=0

for %%C in (python3.12 python3 python) do (
    if !PYTHON_OK! == 0 (
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
)

if !PYTHON_OK! == 0 (
    echo    Python 3.12+ not found. Installing via winget...
    winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    if !errorlevel! neq 0 (
        echo    [ERROR] Python install failed.
        echo    Please install manually: https://www.python.org/downloads/
        pause
        exit /b 1
    )
    set PYTHON_CMD=python
    echo    Python 3.12 installed.
) else (
    echo    Python OK: !PYTHON_CMD!
)

:: 2. Ollama
echo [2/5] Checking Ollama...

ollama --version >nul 2>&1
if !errorlevel! neq 0 (
    echo    Ollama not found. Installing via winget...
    winget install --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements
    if !errorlevel! neq 0 (
        echo    [ERROR] Ollama install failed.
        echo    Please install manually: https://ollama.com/download
        pause
        exit /b 1
    )
    echo    Ollama installed.
) else (
    echo    Ollama OK
)

ollama list >nul 2>&1
if !errorlevel! neq 0 (
    echo    Starting Ollama server...
    start "" /b ollama serve
    timeout /t 3 /nobreak >nul
)

:: 3. venv + dependencies
echo [3/5] Setting up Python environment...

if not exist "venv\" (
    echo    Creating virtualenv...
    !PYTHON_CMD! -m venv venv
)

call venv\Scripts\activate.bat

pip install -q -r requirements.txt
if !errorlevel! neq 0 (
    echo    [ERROR] Dependency install failed.
    pause
    exit /b 1
)
echo    Dependencies ready.

:: 4. Pull models from app_config.yaml
echo [4/5] Pulling models...

!PYTHON_CMD! _pull_models.py

echo    Models ready.

:: 5. Run app
echo [5/5] Starting Vanilla Chat...
echo.
echo  ================================================
echo   Open http://localhost:8000 in your browser
echo   Press Ctrl+C to stop
echo  ================================================
echo.

uvicorn app:app --reload --host 0.0.0.0 --port 8000

pause