"""Auto 200M (INT4) guardian sidecar for Liquid Agent.

Serves P(deny) for a proposed tool call on 127.0.0.1 only.

    POST /classify {"tool", "args", "request", "history"} -> {"p_deny": 0.12}
    GET  /health -> {"ok": true, "model": "..."}

Uses ProCreations/auto-200m-2-int4 through the repo's own auto_quant.py loader
(plain PyTorch; picks Apple MPS, then CPU; Linux gets the CPU build of
PyTorch), and its build_input so the text matches what the model was trained on.
"""

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from huggingface_hub import hf_hub_download, snapshot_download

# Only what the loader reads. The repo also holds a README, benchmarks and
# training scripts that the app never needs.
FILES = [
    "auto_quant.py",
    "auto_quant_int4.safetensors",
    "quant_config.json",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
]
REQUIRED = ["auto_quant.py", "auto_quant_int4.safetensors", "quant_config.json", "config.json", "tokenizer.json"]

parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("LA_GUARDIAN_REPO", "ProCreations/auto-200m-2-int4"))
parser.add_argument("--port", type=int, default=8766)
parser.add_argument("--download-only", action="store_true")
args = parser.parse_args()

if args.download_only:
    snapshot_download(args.repo, allow_patterns=FILES)
    print("downloaded", args.repo)
    sys.exit(0)

# Load from the local folder. Passing the repo name makes the loader ask for a
# complete snapshot, which fails offline because the extras were skipped.
folder = os.path.dirname(hf_hub_download(args.repo, "auto_quant.py"))
missing = [f for f in REQUIRED if not os.path.exists(os.path.join(folder, f))]
if missing:
    sys.exit(f"[guardian] missing {', '.join(missing)}; remove the Safety helper in Settings and get it again")

sys.path.insert(0, folder)
import auto_quant  # noqa: E402

model, tokenizer = auto_quant.load(folder)
# Warm up once so the first real check isn't slow.
auto_quant.score(model, tokenizer, auto_quant.build_input("List my files.", [], {"tool": "Bash", "args": "ls"}))
print(f"[guardian] {args.repo} ready at 127.0.0.1:{args.port}", flush=True)


def as_text(value):
    """Arguments are strings; anything else goes in as compact JSON, as in training."""
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def serialize(body):
    if "text" in body:
        return body["text"]
    history = [{"tool": h["tool"], "args": as_text(h["args"]), "result": h.get("result", "")} for h in body.get("history", [])]
    return auto_quant.build_input(body["request"], history, {"tool": body["tool"], "args": as_text(body["args"])})


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": args.repo})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            text = serialize(json.loads(self.rfile.read(length)))
            self._send(200, {"p_deny": float(auto_quant.score(model, tokenizer, text))})
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
