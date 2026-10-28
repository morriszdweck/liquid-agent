"""Auto 200M guardian sidecar for Liquid Agent.

Serves P(deny) for a proposed tool call on 127.0.0.1 only.

    POST /classify {"text": "<auto-200m input>"} -> {"p_deny": 0.12}
    GET  /health -> {"ok": true, "model": "..."}

Weights are quantized to INT4 with optimum-quanto unless --no-int4 is passed.
"""

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("LA_GUARDIAN_REPO", "ProCreations/auto-200m-2"))
parser.add_argument("--port", type=int, default=8766)
parser.add_argument("--no-int4", action="store_true")
parser.add_argument("--max-tokens", type=int, default=4096)
args = parser.parse_args()

device = "mps" if torch.backends.mps.is_available() else "cpu"
tokenizer = AutoTokenizer.from_pretrained(args.repo)
model = AutoModelForSequenceClassification.from_pretrained(args.repo, dtype=torch.float32).eval()

quant = "fp32"
if not args.no_int4:
    try:
        from optimum.quanto import freeze, qint4, quantize

        quantize(model, weights=qint4)
        freeze(model)
        quant = "int4"
    except Exception as e:  # quanto missing or unsupported layer: fall back, still works
        print(f"[guardian] INT4 unavailable ({e}); running fp32")
model.to(device)
print(f"[guardian] {args.repo} on {device} ({quant}) at 127.0.0.1:{args.port}")


def p_deny(text: str) -> float:
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=args.max_tokens).to(device)
    with torch.inference_mode():
        logits = model(**inputs).logits.float()
    return logits.softmax(-1)[0, 1].item()


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
            self._send(200, {"ok": True, "model": args.repo, "quant": quant})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            text = json.loads(self.rfile.read(length))["text"]
            self._send(200, {"p_deny": p_deny(text)})
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
