"""Bounded observations from Core's network log, without recording block payloads."""

import os
import re
import signal
from datetime import datetime
from pathlib import Path

from .wire import VISIBLE


READ_BUDGET = 2 * 1024 * 1024
LINE_LIMIT = 16 * 1024
LOG_LIMIT = 16 * 1024 * 1024
PREFIX = re.compile(r"^(\d{4}-\d\d-\d\dT\S+) \[net\] (.*)$")
MESSAGE = re.compile(r"^(sending|received:) ([a-z0-9]+) \((\d+) bytes\) peer=(\d+)$")
SUPPORT = re.compile(r"^peer=(\d+) supports staletip announcements with prefers_blocks=([01])$")


class NetworkLogReader:
    def __init__(self):
        self.identity = None
        self.offset = 0
        self.skipping_line = False
        self.lag_bytes = 0

    def reset(self, path, at_end=True):
        try:
            stat = Path(path).stat()
        except FileNotFoundError:
            self.identity, self.offset = None, 0
        else:
            self.identity = (stat.st_dev, stat.st_ino)
            self.offset = stat.st_size if at_end else 0
        self.skipping_line = False
        self.lag_bytes = 0

    @staticmethod
    def parse(line):
        prefix = PREFIX.fullmatch(line.rstrip("\r\n"))
        if not prefix:
            return None
        try:
            timestamp = datetime.fromisoformat(prefix[1].replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
        message, support = MESSAGE.fullmatch(prefix[2]), SUPPORT.fullmatch(prefix[2])
        if support:
            return {"time": timestamp, "kind": "feature", "direction": "recv", "peer_id": int(support[1]),
                    "size": None, "evidence": "debug-log",
                    "details": {"feature": "BIP332", "prefers_blocks": support[2] == "1",
                                "observation": "feature-support", "log": prefix[2]}}
        if not message or message[2] not in VISIBLE:
            return None
        return {"time": timestamp, "kind": message[2], "direction": "sent" if message[1] == "sending" else "recv",
                "peer_id": int(message[4]), "size": int(message[3]), "evidence": "debug-log",
                "details": {"observation": "message", "payload_available": False, "log": prefix[2]}}

    def read(self, path):
        path = Path(path)
        try:
            stream = path.open("rb")
        except FileNotFoundError:
            return []
        events = []
        with stream:
            stat = os.fstat(stream.fileno())
            identity = (stat.st_dev, stat.st_ino)
            if identity != self.identity or stat.st_size < self.offset:
                self.identity, self.offset, self.skipping_line = identity, 0, False
            stream.seek(self.offset)
            consumed = 0
            while consumed < READ_BUDGET:
                line = stream.readline(min(LINE_LIMIT + 1, READ_BUDGET - consumed))
                if not line:
                    break
                consumed += len(line)
                if not line.endswith(b"\n"):
                    if len(line) > LINE_LIMIT or self.skipping_line:
                        self.skipping_line = True
                        self.offset = stream.tell()
                        continue
                    # A partial write or a budget boundary is retried intact.
                    break
                self.offset = stream.tell()
                if self.skipping_line:
                    self.skipping_line = False
                    continue
                event = self.parse(line.decode("utf8", errors="replace"))
                if event:
                    events.append(event)
            self.lag_bytes = max(0, os.fstat(stream.fileno()).st_size - self.offset)
        return events


def rotate_log(path, process, limit=LOG_LIMIT):
    path = Path(path)
    if process.poll() is not None:
        return False
    try:
        if path.stat().st_size < limit:
            return False
    except FileNotFoundError:
        return False
    # Core reopens its log on SIGHUP. Renaming preserves its live file handle;
    # truncating that handle could corrupt writes or make the reader replay data.
    path.replace(path.with_name(path.name + ".1"))
    try:
        process.send_signal(signal.SIGHUP)
    except ProcessLookupError:
        pass
    return True
