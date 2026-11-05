"""Relay for remote control (liquid-rc.mincoffical.codes/relay; M1 uses the same one).

Pairs one Liquid Agent (the host) with the browsers that hold its link, by room id. It
only passes frames along: everything it carries is AES-GCM ciphertext made
with a key it never sees. Plain standard library, run from the site server's
request handler:

    if rc and path == "/relay" and websocket upgrade: rc.serve(handler)

Frames are JSON text. Host <-> relay: {c, d, ...} with c the browser's id
("*" for every browser); the relay tells the host {ev: "join"|"leave", c}.
Browser <-> relay: {d, ...}; the relay tells browsers {ev: "host", up}.
"""

import base64
import hashlib
import json
import os
import re
import socket
import struct
import threading
import time
from urllib.parse import parse_qs, urlsplit

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 4 * 1024 * 1024
MAX_ROOMS = 200
MAX_CLIENTS = 12
ROOM = re.compile(r"^[A-Za-z0-9_-]{32}$")

lock = threading.Lock()
rooms = {}  # room -> {"host": Conn | None, "clients": {cid: Conn}}


class Closed(Exception):
    pass


class Conn:
    def __init__(self, handler):
        self.sock = handler.connection
        self.rfile = handler.rfile
        self.send_lock = threading.Lock()
        self.open = True

    def _read(self, n):
        data = self.rfile.read(n)
        if data is None or len(data) < n:
            raise Closed()
        return data

    def recv(self):
        """Next text message (fragments joined); answers pings; None on close."""
        parts, kind = [], None
        while True:
            b1, b2 = self._read(2)
            fin, op = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            if n > MAX_FRAME:
                raise Closed()
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n) if n else b""
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data)) if n < 64 else _unmask(data, mask)
            if op == 0x8:
                raise Closed()
            if op == 0x9:
                self.send_raw(0xA, data)
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2):
                kind, parts = op, [data]
            elif op == 0x0:
                parts.append(data)
            if sum(len(p) for p in parts) > MAX_FRAME:
                raise Closed()
            if fin and kind:
                return b"".join(parts).decode("utf-8", "replace")

    def send_raw(self, op, data):
        head = bytes([0x80 | op])
        n = len(data)
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack("!H", n)
        else:
            head += bytes([127]) + struct.pack("!Q", n)
        with self.send_lock:
            if not self.open:
                return
            try:
                self.sock.sendall(head + data)
            except OSError:
                self.open = False

    def send(self, obj):
        self.send_raw(0x1, json.dumps(obj, separators=(",", ":")).encode())

    def close(self):
        if self.open:
            self.send_raw(0x8, b"")
        self.open = False
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def _unmask(data, mask):
    # XOR via big ints: fast enough for megabyte frames in pure Python.
    n = len(data)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def _pinger(conn):
    # Cloudflare drops quiet sockets after ~100 s.
    while conn.open:
        time.sleep(25)
        conn.send_raw(0x9, b"")


def serve(handler):
    q = parse_qs(urlsplit(handler.path).query)
    room = (q.get("room") or [""])[0]
    role = (q.get("role") or [""])[0]
    key = handler.headers.get("Sec-WebSocket-Key", "")
    if not ROOM.match(room) or role not in ("host", "client") or not key:
        handler.send_error(400)
        return
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    handler.close_connection = True
    handler.send_response(101)
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept)
    handler.end_headers()
    handler.wfile.flush()
    handler.connection.settimeout(None)
    conn = Conn(handler)
    threading.Thread(target=_pinger, args=(conn,), daemon=True).start()
    try:
        if role == "host":
            _host(conn, room)
        else:
            _client(conn, room)
    except (Closed, OSError, ValueError):
        pass
    finally:
        conn.close()


def _room(room):
    r = rooms.get(room)
    if r is None:
        if len(rooms) >= MAX_ROOMS:
            return None
        r = rooms[room] = {"host": None, "clients": {}}
    return r


def _tidy(room):
    r = rooms.get(room)
    if r and r["host"] is None and not r["clients"]:
        del rooms[room]


def _host(conn, room):
    with lock:
        r = _room(room)
        if r is None:
            return
        old, r["host"] = r["host"], conn
        clients = list(r["clients"].items())
    if old:
        old.close()
    for cid, c in clients:
        conn.send({"ev": "join", "c": cid})
        c.send({"ev": "host", "up": True})
    try:
        while True:
            text = conn.recv()
            try:
                f = json.loads(text)
                target = f.pop("c")
            except (ValueError, KeyError, AttributeError):
                continue
            with lock:
                cs = r["clients"]
                targets = list(cs.values()) if target == "*" else [cs[target]] if target in cs else []
            for c in targets:
                c.send(f)
    finally:
        with lock:
            if r["host"] is conn:
                r["host"] = None
                clients = list(r["clients"].values())
            else:
                clients = []
            _tidy(room)
        for c in clients:
            c.send({"ev": "host", "up": False})


def _client(conn, room):
    cid = base64.urlsafe_b64encode(os.urandom(9)).decode()
    with lock:
        r = _room(room)
        if r is None or len(r["clients"]) >= MAX_CLIENTS:
            return
        r["clients"][cid] = conn
        host = r["host"]
    conn.send({"ev": "host", "up": host is not None})
    if host:
        host.send({"ev": "join", "c": cid})
    try:
        while True:
            text = conn.recv()
            try:
                f = json.loads(text)
                if not isinstance(f, dict):
                    continue
            except ValueError:
                continue
            f["c"] = cid
            f.pop("ev", None)
            with lock:
                host = r["host"]
            if host:
                host.send(f)
    finally:
        with lock:
            r["clients"].pop(cid, None)
            host = r["host"]
            _tidy(room)
        if host:
            host.send({"ev": "leave", "c": cid})
