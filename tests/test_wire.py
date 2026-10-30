"""Protocol fixtures and incremental capture tests; no node process is required."""

import struct
import tempfile
import unittest
from pathlib import Path

from relay_lab.wire import CaptureReader, Reader, block_hash, decode


GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
GENESIS_HEADER = bytes.fromhex(
    "01000000"
    "0000000000000000000000000000000000000000000000000000000000000000"
    "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"
    "29ab5f49ffff001d1dac2b7c"
)
SECOND_HEADER = bytes.fromhex(
    "02000000"
    "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000"
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    "00f15365ffff7f202a000000"
)
SECOND_HASH = "cb1b46e7b240d00d2a4f730b46f7f92dddadc789c8c0593dd01e9af9d506f723"


def feature(payload, name=b"BIP332"):
    return bytes([len(name)]) + name + bytes([len(payload)]) + payload


def staletip(headers=(GENESIS_HEADER,), have=True):
    return (bytes(32) + bytes([len(headers)])
            + b"".join(header[:4] + header[36:] for header in headers)
            + bytes([have]))


def record(kind, payload=b"", time=1_000_000):
    return struct.pack("<Q12sI", time, kind.encode("ascii"), len(payload)) + payload


class ProtocolTests(unittest.TestCase):
    def test_reference_genesis_hash(self):
        self.assertEqual(block_hash(GENESIS_HEADER), GENESIS_HASH)
        for kind in ("block", "cmpctblock"):
            decoded = decode(kind, GENESIS_HEADER + b"transaction bytes are not decoded here")
            self.assertEqual(decoded["hash"], GENESIS_HASH)
            self.assertEqual(decoded["parent"], "00" * 32)

    def test_compactsize_boundaries_and_limit(self):
        fixtures = [
            (b"\x00", 0), (b"\xfc", 252),
            (bytes.fromhex("fdfd00"), 253),
            (bytes.fromhex("fdffff"), 65535),
            (bytes.fromhex("fe00000100"), 65536),
            (bytes.fromhex("feffffffff"), 4294967295),
            (bytes.fromhex("ff0000000001000000"), 4294967296),
        ]
        for encoded, expected in fixtures:
            with self.subTest(expected=expected):
                reader = Reader(encoded)
                self.assertEqual(reader.count(limit=2 ** 64 - 1), expected)
                self.assertEqual(reader.pos, len(encoded))
        with self.assertRaises(ValueError):
            Reader(bytes.fromhex("fdfd00")).count(limit=252)

    def test_nonminimal_and_truncated_compactsize(self):
        for encoded in (b"", b"\xfd", b"\xfd\x00", b"\xfe\x00\x00\x01",
                        b"\xff" + bytes(7), bytes.fromhex("fdfc00"),
                        bytes.fromhex("feffff0000"), bytes.fromhex("ffffffffff00000000")):
            with self.subTest(encoded=encoded.hex()), self.assertRaises(ValueError):
                Reader(encoded).count(limit=2 ** 64 - 1)

    def test_only_valid_bip332_preferences_are_reported(self):
        self.assertIs(decode("feature", feature(b"\x00"))["prefers_blocks"], False)
        self.assertIs(decode("feature", feature(b"\x01"))["prefers_blocks"], True)
        for payload in (b"", b"\x02", b"\xff", b"\x00\x01"):
            with self.subTest(payload=payload.hex()):
                self.assertIsNone(decode("feature", feature(payload))["prefers_blocks"])
        self.assertIsNone(decode("feature", feature(b"\x01", b"BIP999"))["prefers_blocks"])

    def test_feature_framing_cannot_fake_successful_negotiation(self):
        invalid = (feature(b"\x01") + b"\x00", feature(b"\x01")[:-1],
                   feature(b"\x01", b"BIP"), feature(b"\x01", b"x" * 81),
                   b"\x06BIP332\xfd\x01\x02" + bytes(513))
        for payload in invalid:
            with self.subTest(payload=payload.hex()), self.assertRaises(ValueError):
                decode("feature", payload)

    def test_staletip_reconstructs_hash_and_timestamp(self):
        decoded = decode("staletip", staletip())
        self.assertEqual(decoded["fork_point"], "00" * 32)
        self.assertEqual(decoded["tip"], GENESIS_HASH)
        self.assertEqual(decoded["header_count"], 1)
        self.assertEqual(decoded["hashes"], [GENESIS_HASH])
        self.assertEqual(decoded["headers"][0]["time"], 1231006505)
        self.assertIs(decoded["have_block"], True)
        self.assertIs(decode("staletip", staletip(have=False))["have_block"], False)

    def test_staletip_reconstructs_linear_branch(self):
        decoded = decode("staletip", staletip((GENESIS_HEADER, SECOND_HEADER)))
        self.assertEqual(decoded["header_count"], 2)
        self.assertEqual(decoded["headers"][1]["parent"], GENESIS_HASH)
        self.assertEqual(decoded["headers"][1]["time"], 1700000000)
        self.assertEqual(decoded["tip"], SECOND_HASH)
        self.assertEqual(decoded["hashes"], [GENESIS_HASH, SECOND_HASH])

    def test_staletip_rejects_truncation_empty_headers_and_invalid_bool(self):
        valid = staletip((GENESIS_HEADER, SECOND_HEADER))
        for length in (0, 31, 32, 33, 80, 81, 128, len(valid) - 1):
            with self.subTest(length=length), self.assertRaises(ValueError):
                decode("staletip", valid[:length])
        for invalid in (staletip(()), valid[:-1] + b"\x02", valid + b"\x00"):
            with self.subTest(invalid=invalid.hex()), self.assertRaises(ValueError):
                decode("staletip", invalid)

    def test_inventory_keeps_witness_flags_and_display_hash_order(self):
        payload = b"\x01" + struct.pack("<I", 0x40000002) + bytes.fromhex(GENESIS_HASH)[::-1]
        for kind in ("inv", "getdata", "notfound"):
            with self.subTest(kind=kind):
                decoded = decode(kind, payload)
                self.assertEqual(decoded["items"], [{"type": 0x40000002, "hash": GENESIS_HASH}])
                self.assertEqual(decoded["hashes"], [GENESIS_HASH])


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.peer = self.root / "127.0.0.1_19000"
        self.peer.mkdir()
        self.reader = CaptureReader()

    def test_partial_records_are_retried_without_duplicate_events(self):
        path = self.peer / "msgs_recv.dat"
        first = record("feature", feature(b"\x01"), time=1_500_000)
        second = record("staletip", staletip(), time=2_000_000)
        path.write_bytes(first[:10])
        self.assertEqual(self.reader.read(self.root), [])
        with path.open("ab") as stream:
            stream.write(first[10:-1])
        self.assertEqual(self.reader.read(self.root), [])
        with path.open("ab") as stream:
            stream.write(first[-1:] + second[:25])
        events = self.reader.read(self.root)
        self.assertEqual([e["kind"] for e in events], ["feature"])
        self.assertEqual(events[0]["time"], 1.5)
        self.assertEqual(events[0]["peer_address"], "127.0.0.1:19000")
        self.assertEqual(events[0]["direction"], "recv")
        self.assertEqual(self.reader.read(self.root), [])
        with path.open("ab") as stream:
            stream.write(second[25:])
        self.assertEqual([e["kind"] for e in self.reader.read(self.root)], ["staletip"])
        self.assertEqual(self.reader.read(self.root), [])

    def test_offsets_are_per_file_and_events_sort_by_processing_time(self):
        incoming = self.peer / "msgs_recv.dat"
        outgoing = self.peer / "msgs_sent.dat"
        incoming.write_bytes(record("feature", feature(b"\x00"), time=3_000_000))
        outgoing.write_bytes(record("version", struct.pack("<i", 70017), time=1_000_000)
                             + record("verack", time=2_000_000))
        events = self.reader.read(self.root)
        self.assertEqual([e["kind"] for e in events], ["version", "verack", "feature"])
        self.assertEqual([e["direction"] for e in events], ["sent", "sent", "recv"])
        with incoming.open("ab") as stream:
            stream.write(record("verack", time=4_000_000))
        self.assertEqual([e["kind"] for e in self.reader.read(self.root)], ["verack"])
        self.assertEqual(self.reader.read(self.root), [])

    def test_ignored_and_malformed_messages_do_not_hide_later_records(self):
        path = self.peer / "msgs_recv.dat"
        path.write_bytes(record("ping", bytes(8))
                         + record("staletip", b"bad", time=2_000_000)
                         + record("verack", time=3_000_000))
        events = self.reader.read(self.root)
        self.assertEqual([e["kind"] for e in events], ["staletip", "verack"])
        self.assertIn("decode_error", events[0]["details"])
        self.assertEqual(events[0]["details"]["raw"], b"bad".hex())
        self.assertEqual(self.reader.read(self.root), [])

    def test_file_truncation_starts_a_new_stream(self):
        path = self.peer / "msgs_sent.dat"
        path.write_bytes(record("feature", feature(b"\x01")))
        self.assertEqual(len(self.reader.read(self.root)), 1)
        path.write_bytes(record("verack"))
        self.assertEqual([e["kind"] for e in self.reader.read(self.root)], ["verack"])

    def test_capture_length_is_bounded_before_payload_allocation(self):
        path = self.peer / "msgs_recv.dat"
        path.write_bytes(struct.pack("<Q12sI", 1, b"block", 32 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "32 MiB"):
            self.reader.read(self.root)


if __name__ == "__main__":
    unittest.main()
