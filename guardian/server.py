"""Auto 150M guardian sidecar for Liquid Agent.

Serves P(deny) for a proposed tool call on 127.0.0.1 only.

    POST /classify {"tool", "args", "request", "history"} -> {"p_deny": 0.12}
    GET  /health -> {"ok": true, "model": "..."}

Uses ProCreations/auto-150m-3, a ModernBERT classifier (0 = approve,
1 = deny), with plain Transformers: BF16 on Apple MPS, FP32 on the CPU (Linux
gets the CPU build of PyTorch). The text is serialized exactly as the model
card shows, since that is what it was trained on.
"""

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from huggingface_hub import hf_hub_download, snapshot_download

# Only what the model needs. The repo also holds a README, charts and eval scores.
FILES = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"]
# Auto's own runtime fits a session to 8,192 tokens on Apple silicon and CPUs.
MAX_TOKENS = 8192

parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("LA_GUARDIAN_REPO", "ProCreations/auto-150m-3"))
parser.add_argument("--port", type=int, default=8766)
parser.add_argument("--download-only", action="store_true")
args = parser.parse_args()

if args.download_only:
    snapshot_download(args.repo, allow_patterns=FILES)
    print("downloaded", args.repo)
    sys.exit(0)

# Load from the local folder; the app starts this offline.
folder = os.path.dirname(hf_hub_download(args.repo, "config.json"))
missing = [f for f in FILES if not os.path.exists(os.path.join(folder, f))]
if missing:
    sys.exit(f"[guardian] missing {', '.join(missing)}; remove the Safety helper in Settings and get it again")

import torch  # noqa: E402
from transformers import AutoModelForSequenceClassification, AutoTokenizer  # noqa: E402

device = "mps" if torch.backends.mps.is_available() else "cpu"
tokenizer = AutoTokenizer.from_pretrained(folder)
model = AutoModelForSequenceClassification.from_pretrained(folder, dtype=torch.bfloat16 if device == "mps" else torch.float32)
model = model.to(device).eval()


def as_text(value):
    """Arguments are strings; anything else goes in as compact JSON, as in training."""
    return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def build_input(request, history, call):
    """The serialization every Auto model was trained on: proposed call, user request, agent history."""
    parts = ["### PROPOSED TOOL CALL", f"tool: {call['tool']}", f"args: {as_text(call['args'])}", "", "### USER REQUEST", request, "", "### AGENT HISTORY"]
    if not history:
        parts.append("(no prior actions)")
    for i, h in enumerate(history, 1):
        parts.append(f"[{i}] {h['tool']}({as_text(h['args'])})\n-> {as_text(h.get('result', ''))}")
    return "\n".join(parts)


def score(text):
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=MAX_TOKENS).to(device)
    with torch.inference_mode():
        return model(**inputs).logits.float().softmax(-1)[0, 1].item()


def serialize(body):
    if "text" in body:
        return body["text"]
    call = {"tool": body["tool"], "args": body["args"]}
    history = list(body.get("history", []))
    text = build_input(body["request"], history, call)
    # Too long: drop the oldest actions first, so the call and the request always fit.
    while history and len(tokenizer(text)["input_ids"]) > MAX_TOKENS:
        history = history[1:]
        text = build_input(body["request"], history, call)
    return text


# Warm up once so the first real check isn't slow.
score(build_input("List my files.", [], {"tool": "Bash", "args": "ls"}))
print(f"[guardian] {args.repo} ready on {device} at 127.0.0.1:{args.port}", flush=True)


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
            self._send(200, {"p_deny": float(score(text))})
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
