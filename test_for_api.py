"""Check whether DASHSCOPE_API_KEY still works.

Sends one tiny chat request to DashScope's OpenAI-compatible API, the same way
server/qwen.ts does. Reads DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL and QWEN_MODEL
from the environment, falling back to .env.local / .env in this folder.

    python3 test_for_api.py

Exit code 0 = key works, 1 = it does not.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
MODEL = "qwen3-vl-plus"


def load_dotenv():
    for name in (".env.local", ".env"):
        path = Path(__file__).with_name(name)
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def main():
    load_dotenv()
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        print("FAIL: DASHSCOPE_API_KEY is not set (env, .env.local or .env)")
        return 1
    base_url = (os.environ.get("DASHSCOPE_BASE_URL") or BASE_URL).rstrip("/")
    model = os.environ.get("QWEN_MODEL") or MODEL
    print(f"key {api_key[:5]}…{api_key[-4:]}  model {model}  endpoint {base_url}")

    body = json.dumps({
        "model": model,
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "Reply with the word OK."}],
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.load(res)
    except urllib.error.HTTPError as e:
        print(f"FAIL: HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
        if e.code == 401:
            print("The key is invalid, expired or for the other region (try DASHSCOPE_BASE_URL).")
        elif e.code == 403:
            print("The key is accepted, but this model's quota is used up or not paid for.")
        elif e.code == 404:
            print("The key is accepted, but this model is not available to it (try QWEN_MODEL).")
        return 1
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"FAIL: could not reach DashScope: {e}")
        return 1

    reply = data.get("choices", [{}])[0].get("message", {}).get("content")
    print(f"OK: the key works. Model replied: {reply!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
