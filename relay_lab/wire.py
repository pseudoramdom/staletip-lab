"""Decode Core's application-level P2P captures, including partial live writes."""

import hashlib
import struct
from pathlib import Path


def block_hash(header):
    return hashlib.sha256(hashlib.sha256(header).digest()).digest()[::-1].hex()


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, count):
        if count < 0 or self.pos + count > len(self.data):
            raise ValueError("Truncated message")
        result = self.data[self.pos:self.pos + count]
        self.pos += count
        return result

    def count(self, limit=50000):
        value = self.take(1)[0]
        if value >= 253:
            size = {253: 2, 254: 4, 255: 8}[value]
            value = int.from_bytes(self.take(size), "little")
            if value < {2: 253, 4: 65536, 8: 4294967296}[size]:
                raise ValueError("Non-minimal CompactSize")
        if value > limit:
            raise ValueError("Message count exceeds display limit")
        return value

    def string(self):
        return self.take(self.count())


def decode(kind, data):
    r = Reader(data)
    if kind == "version":
        return {"version": struct.unpack("<i", r.take(4))[0]}
    if kind == "feature":
        feature_bytes, payload = r.string(), r.string()
        if not 4 <= len(feature_bytes) <= 80 or len(payload) > 512 or r.pos != len(data):
            raise ValueError("Invalid feature payload")
        feature = feature_bytes.decode("utf8", errors="replace")
        return {"feature": feature, "data": payload.hex(),
                "prefers_blocks": bool(payload[0]) if feature == "BIP332" and payload in (b"\x00", b"\x01") else None}
    if kind == "staletip":
        previous = r.take(32)
        fork = previous[::-1].hex()
        headers = []
        for _ in range(r.count(2000)):
            compressed = r.take(48)
            header = compressed[:4] + previous + compressed[4:]
            h = block_hash(header)
            headers.append({"hash": h, "parent": previous[::-1].hex(),
                            "time": int.from_bytes(compressed[36:40], "little")})
            previous = bytes.fromhex(h)[::-1]
        have = r.take(1)[0]
        if not headers or have not in (0, 1) or r.pos != len(data):
            raise ValueError("Invalid staletip payload")
        return {"fork_point": fork, "headers": headers, "hashes": [h["hash"] for h in headers],
                "tip": headers[-1]["hash"], "have_block": bool(have), "header_count": len(headers)}
    if kind in ("inv", "getdata", "notfound"):
        items = [{"type": int.from_bytes(r.take(4), "little"), "hash": r.take(32)[::-1].hex()}
                 for _ in range(r.count())]
        return {"items": items, "hashes": [i["hash"] for i in items]}
    if kind in ("block", "cmpctblock"):
        header = r.take(80)
        return {"hash": block_hash(header), "parent": header[4:36][::-1].hex(),
                "hashes": [block_hash(header)]}
    if kind == "headers":
        headers = []
        for _ in range(r.count(2000)):
            header = r.take(80)
            r.count()
            headers.append({"hash": block_hash(header), "parent": header[4:36][::-1].hex()})
        return {"headers": headers, "hashes": [h["hash"] for h in headers]}
    return {}


VISIBLE = {"version", "verack", "feature", "staletip", "getdata", "block", "headers", "inv", "notfound", "cmpctblock"}


class CaptureReader:
    def __init__(self):
        self.offsets = {}

    def read(self, root):
        events = []
        for path in sorted(Path(root).glob("*/*.dat")):
            key = str(path)
            offset = self.offsets.get(key, 0)
            if path.stat().st_size < offset:
                offset = 0
            with path.open("rb") as stream:
                stream.seek(offset)
                # Never consume an incomplete record: Core writes the header
                # and payload separately and the next poll must retry both.
                for _ in range(1000):
                    header = stream.read(24)
                    if len(header) != 24:
                        break
                    timestamp, kind, length = struct.unpack("<Q12sI", header)
                    if length > 32 * 1024 * 1024:
                        raise ValueError("Capture record exceeds 32 MiB")
                    payload = stream.read(length)
                    if len(payload) != length:
                        break
                    offset = stream.tell()
                    name = kind.rstrip(b"\x00").decode("ascii", errors="replace")
                    if name not in VISIBLE:
                        continue
                    try:
                        details = decode(name, payload)
                    except (ValueError, IndexError, struct.error) as error:
                        details = {"decode_error": str(error), "raw": payload[:256].hex()}
                    events.append({"time": timestamp / 1_000_000, "kind": name,
                                   "direction": "recv" if "recv" in path.name else "sent",
                                   "peer_address": path.parent.name.replace("_", ":"),
                                   "size": length, "details": details})
            self.offsets[key] = offset
        return sorted(events, key=lambda event: event["time"])
