"""Loopback-only HTTP API and server-sent snapshots for the relay laboratory."""

import argparse
import json
import mimetypes
import signal
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .config import find_bin_dir


STATIC = Path(__file__).parent / "static"


class LabServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, lab):
        self.lab = lab
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "") not in ("200", "202"):
            super().log_message(fmt, *args)

    def allowed_origin(self):
        port = self.server.server_port
        hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in hosts and (origin is None or origin in {"http://" + h for h in hosts})

    def headers_for(self, status, content_type, length=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length", str(length))

    def send_json(self, value, status=200, attachment=False):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.headers_for(status, "application/json; charset=utf-8", len(data))
        if attachment:
            self.send_header("Content-Disposition", 'attachment; filename="staletip-session.json"')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            self.get()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def get(self):
        if not self.allowed_origin():
            self.send_json({"error": "This server accepts same-origin loopback requests only."}, 403)
            return
        path = urlsplit(self.path).path
        if path in ("/api/state", "/api/export"):
            self.send_json(self.server.lab.snapshot(), attachment=path.endswith("export"))
            return
        if path == "/api/stream":
            self.headers_for(200, "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.end_headers()
            self.connection.settimeout(5)
            while not getattr(self.server.lab, "closed", False):
                data = json.dumps(self.server.lab.snapshot(), ensure_ascii=False, allow_nan=False)
                self.wfile.write(("event: state\ndata: " + data + "\n\n").encode())
                self.wfile.flush()
                time.sleep(1)
            return
        # An allowlist keeps captures, cookies, private files, and Python source
        # outside the HTTP surface, even if an encoded path contains ../.
        files = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}
        if path not in files:
            self.send_json({"error": "Not found"}, 404)
            return
        file = STATIC / files[path]
        if not file.is_file():
            self.send_json({"error": "Web interface is not installed."}, 503)
            return
        data = file.read_bytes()
        kind = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        self.headers_for(200, kind + "; charset=utf-8", len(data))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            self.post()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def post(self):
        # The custom header forces browser requests from another origin through
        # a CORS preflight, which this server does not allow. Host validation
        # also prevents a rebound hostname from controlling local processes.
        if not self.allowed_origin() or self.headers.get("X-Lab-Request") != "1":
            self.close_connection = True
            self.send_json({"error": "Same-origin X-Lab-Request header required."}, 403)
            return
        if urlsplit(self.path).path != "/api/action":
            self.close_connection = True
            self.send_json({"error": "Not found"}, 404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 65536:
                raise ValueError("Action body must be between 1 byte and 64 KiB.")
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Send actions as application/json.")
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict) or not isinstance(data.get("action"), str):
                raise ValueError("Expected an object with an action name.")
            action = data.pop("action")
            job = self.server.lab.submit(action, data)
            self.send_json(job, 202)
        except (ValueError, TypeError) as error:
            self.close_connection = True
            self.send_json({"error": str(error)}, 400)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a regtest laboratory or monitor testnet4 and signet.")
    parser.add_argument("--bin-dir", type=Path, help="Directory containing the BIP332 bitcoind and bitcoin-cli (default: BITCOIN_BIN_DIR, then PATH)")
    parser.add_argument("--network", choices=("regtest", "testnet4", "signet"), default="regtest", help="Network to run (default: regtest)")
    parser.add_argument("--port", type=int, help="Loopback web port (default: regtest 8765, testnet4 8766, signet 8767)")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "runs", help="Parent directory for retained session artifacts")
    parser.add_argument("--observe", type=Path, help="JSON configuration for read-only monitoring of existing nodes")
    args = parser.parse_args(argv)
    if args.port is None:
        args.port = {"regtest": 8765, "testnet4": 8766, "signet": 8767}[args.network]
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    observers = None
    if args.observe:
        if args.network == "regtest":
            parser.error("Observer mode supports testnet4 and signet; choose --network")
        try:
            config = json.loads(args.observe.expanduser().read_text())
            observers = config["nodes"]
            if not isinstance(observers, list) or not 1 <= len(observers) <= 8:
                raise ValueError("Observer configuration requires 1–8 nodes")
        except (OSError, ValueError, KeyError, TypeError) as error:
            parser.error("Invalid observer configuration: %s" % error)
        args.bin_dir = None
    else:
        if args.network == "signet":
            parser.error("Signet currently requires --observe; mining and managed nodes are not supported")
        try:
            args.bin_dir = find_bin_dir(args.bin_dir)
        except ValueError as error:
            parser.error(str(error))
    from .core import Lab
    from .networks import Regtest, Testnet4, Signet
    network = {"regtest": Regtest, "testnet4": Testnet4, "signet": Signet}[args.network]()
    run_id = (("observe-" if observers is not None else "") + network.name) if network.persistent else datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    run_dir = args.data_dir.expanduser().resolve() / run_id
    run_dir.mkdir(parents=True, exist_ok=network.persistent, mode=0o700)
    try:
        lab = Lab(args.bin_dir, run_dir, network=network, observers=observers)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    server = None
    try:
        server = LabServer(("127.0.0.1", args.port), lab)
        def stop_on_signal(*_):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, stop_on_signal)
        print("\nStaletip relay laboratory\n  Network: %s\n  Open: http://127.0.0.1:%d\n  Session: %s\n  Binaries: %s\n\nPress Ctrl+C to stop the server. Observer nodes remain running.\n" % (network.name, args.port, run_dir, args.bin_dir), flush=True)
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nStopping observer…" if observers is not None else "\nStopping miners and owned nodes…", flush=True)
    except OSError as error:
        print("Unable to start server: %s" % error, file=sys.stderr)
        return 1
    finally:
        lab.close()
        if server:
            server.server_close()
        print("Session files retained at %s" % lab.run_dir, flush=True)
    return 0
