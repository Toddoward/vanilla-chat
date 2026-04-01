"""_pull_models.py — start.bat에서 호출하는 모델 다운로드 헬퍼"""
import yaml
import subprocess

try:
    with open("app_config.yaml", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    models = cfg.get("models", {})
    seen = set()
    for slot, name in models.items():
        if not name or name in seen:
            continue
        seen.add(name)
        if "FlagEmbedding" in name:
            continue
        if slot in ("embedding", "reranker") and "bge" in name.lower():
            continue
        print(f"  pulling {name} ...")
        result = subprocess.run(["ollama", "pull", name])
        if result.returncode != 0:
            print(f"  [warning] {name} pull failed — run manually later.")
except Exception as e:
    print(f"  [warning] model check failed: {e}")