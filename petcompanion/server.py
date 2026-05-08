"""HTTP server for the Pet Companion web UI and API."""

from __future__ import annotations

import json
import logging
import mimetypes
import queue
import signal
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

from petcompanion.assets import scan_pets, get_pet_spritesheet, resolve_pet
from petcompanion.config import load_config, save_config
from petcompanion.events import EventHub

log = logging.getLogger("pet-companion")

STATIC_DIR = Path(__file__).parent / "pet_static"

MIME_OVERRIDES = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
}

_CORS = {"Access-Control-Allow-Origin": "*"}


def _enrich_pet_config(config: dict) -> dict:
    """Inject spritesheet URL and atlas for selected pets.

    When petId points to a discovered pet (not "custom") and the custom
    slot has no imageUrl/atlas, resolve the spritesheet URL and Codex
    atlas layout so the frontend renders the actual sprite.
    """
    pet_id = config.get("petId", "")
    if pet_id in ("", "custom"):
        return config
    custom = config.get("custom", {})
    if custom.get("imageUrl") and custom.get("atlas"):
        return config
    info = resolve_pet(pet_id)
    if info is None:
        return config
    enriched = dict(config)
    custom = dict(custom)
    custom["imageUrl"] = info["spritesheetUrl"]
    custom["atlas"] = info["atlas"]
    if not custom.get("name") or custom.get("name") == "Funk":
        custom["name"] = info["displayName"]
    enriched["custom"] = custom
    return enriched


class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class _Handler(BaseHTTPRequestHandler):
    event_hub: EventHub
    shutdown_server: callable | None = None

    def log_message(self, fmt: str, *args: object) -> None:
        log.debug(fmt, *args)

    def _send(self, code: int, body: bytes, ct: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ct)
        for k, v in _CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: object) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json")

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    # ------------------------------------------------------------------
    # GET
    # ------------------------------------------------------------------
    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/pet":
            return self._json(200, _enrich_pet_config(load_config()))

        if path == "/api/pets":
            return self._json(200, {"pets": scan_pets()})

        if path.startswith("/api/pets/") and path.endswith("/spritesheet"):
            pet_id = path[len("/api/pets/") : -len("/spritesheet")]
            result = get_pet_spritesheet(pet_id)
            if result is None:
                return self._json(404, {"error": "pet not found"})
            fpath, ct = result
            return self._send(200, fpath.read_bytes(), ct)

        if path == "/api/events":
            return self._handle_sse()

        # Static files
        rel = "index.html" if path == "/" else path.lstrip("/")
        if ".." in rel:
            return self._json(403, {"error": "forbidden"})
        fpath = STATIC_DIR / rel
        if fpath.is_file():
            ct = MIME_OVERRIDES.get(
                fpath.suffix, mimetypes.guess_type(str(fpath))[0] or "application/octet-stream"
            )
            return self._send(200, fpath.read_bytes(), ct)

        self._json(404, {"error": "not found"})

    # ------------------------------------------------------------------
    # SSE
    # ------------------------------------------------------------------
    def _handle_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        for k, v in _CORS.items():
            self.send_header(k, v)
        self.end_headers()

        q = self.event_hub.subscribe()
        try:
            while True:
                try:
                    event = q.get(timeout=30)
                except queue.Empty:
                    # Keepalive
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                data = json.dumps(event, ensure_ascii=False)
                self.wfile.write(f"data: {data}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.event_hub.unsubscribe(q)

    # ------------------------------------------------------------------
    # POST
    # ------------------------------------------------------------------
    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/event":
            return self._handle_emit()

        if path == "/api/pet":
            return self._handle_save_pet()

        if path == "/api/shutdown":
            return self._handle_shutdown()

        self._json(404, {"error": "not found"})

    def _handle_emit(self) -> None:
        body = self._read_body()
        try:
            event = json.loads(body)
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})
        if "type" not in event:
            return self._json(400, {"error": "missing 'type' field"})
        n = self.event_hub.emit(event)
        self._json(200, {"delivered": n})

    def _handle_save_pet(self) -> None:
        body = self._read_body()
        try:
            config = json.loads(body)
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})
        save_config(config)
        self.event_hub.emit({"type": "config-updated"})
        self._json(200, {"ok": True})

    def _handle_shutdown(self) -> None:
        shutdown_server = self.shutdown_server
        self._json(200, {"ok": True})
        if shutdown_server is not None:
            threading.Thread(target=shutdown_server, daemon=True).start()

    # ------------------------------------------------------------------
    # PUT
    # ------------------------------------------------------------------
    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/pet":
            return self._handle_save_pet()
        self._json(404, {"error": "not found"})

    # ------------------------------------------------------------------
    # OPTIONS (CORS preflight)
    # ------------------------------------------------------------------
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        for k, v in _CORS.items():
            self.send_header(k, v)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def start_server(host: str = "127.0.0.1", port: int = 19821) -> None:
    hub = EventHub()
    _Handler.event_hub = hub

    server = ThreadedServer((host, port), _Handler)
    _Handler.shutdown_server = server.shutdown
    log.info("Pet Companion listening on http://%s:%d", host, port)

    def _shutdown(signum: int, frame: object) -> None:
        log.info("Shutting down...")
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log.info("Server stopped.")
