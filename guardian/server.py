"""Auto 200M (INT4) guardian sidecar for Liquid Agent.

Serves P(deny) for a proposed tool call on 127.0.0.1 only.

    POST /classify {"text": "<auto-200m input>"} -> {"p_deny": 0.12}
    GET  /health -> {"ok": true, "model": "..."}

Uses ProCreations/auto-200m-2-int4 through the repo's own auto_quant.py loader
(plain PyTorch; picks Apple MPS, then CPU).
"""

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from huggingface_hub import hf_hub_download, snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("LA_GUARDIAN_REPO", "ProCreations/auto-200m-2-int4"))
parser.add_argument("--port", type=int, default=8766)
parser.add_argument("--download-only", action="store_true")
args = parser.parse_args()

if args.download_only:
    snapshot_download(args.repo, allow_patterns=["*.py", "*.json", "*.safetensors"])
    print("downloaded", args.repo)
    sys.exit(0)

sys.path.insert(0, os.path.dirname(hf_hub_download(args.repo, "auto_quant.py")))
import auto_quant  # noqa: E402

model, tokenizer = auto_quant.load(args.repo)
print(f"[guardian] {args.repo} ready at 127.0.0.1:{args.port}", flush=True)


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
            text = json.loads(self.rfile.read(length))["text"]
            self._send(200, {"p_deny": float(auto_quant.score(model, tokenizer, text))})
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
