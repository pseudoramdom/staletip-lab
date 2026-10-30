import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from relay_lab.logs import NetworkLogReader, rotate_log


def line(message):
    return ("2026-10-29T18:31:44.123456Z [net] " + message + "\n").encode()


class NetworkLogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "debug.log"
        self.reader = NetworkLogReader()

    def test_messages_and_negotiation_are_separate_observations(self):
        self.path.write_bytes(line("sending feature (9 bytes) peer=5")
                              + line("peer=5 supports staletip announcements with prefers_blocks=1")
                              + line("received: staletip (82 bytes) peer=5")
                              + line("ignoring unnegotiated staletip from peer=8"))
        sent, support, arrived = self.reader.read(self.path)
        self.assertEqual(sent["direction"], "sent")
        self.assertNotIn("prefers_blocks", sent["details"])
        self.assertFalse(sent["details"]["payload_available"])
        self.assertTrue(support["details"]["prefers_blocks"])
        self.assertEqual(support["details"]["observation"], "feature-support")
        self.assertEqual((arrived["peer_id"], arrived["direction"], arrived["kind"]), (5, "recv", "staletip"))
        self.assertEqual(arrived["evidence"], "debug-log")
        self.assertEqual(self.reader.read(self.path), [])

    def test_partial_lines_restart_and_rotation(self):
        first = line("received: verack (0 bytes) peer=2")
        self.path.write_bytes(first[:-1])
        self.assertEqual(self.reader.read(self.path), [])
        with self.path.open("ab") as stream:
            stream.write(b"\n")
        self.assertEqual(self.reader.read(self.path)[0]["kind"], "verack")
        self.reader.reset(self.path)
        self.assertEqual(self.reader.read(self.path), [])
        process = Mock()
        process.poll.return_value = None
        self.assertTrue(rotate_log(self.path, process, limit=1))
        self.assertEqual(self.path.with_name("debug.log.1").read_bytes(), first)
        process.send_signal.assert_called_once()
        self.path.write_bytes(line("received: version (103 bytes) peer=0"))
        self.assertEqual(self.reader.read(self.path)[0]["kind"], "version")

    def test_budget_retains_unread_lines_and_skips_oversized_lines(self):
        message = line("received: verack (0 bytes) peer=2")
        self.path.write_bytes(message * 3)
        with patch("relay_lab.logs.READ_BUDGET", len(message) + 10):
            self.assertEqual(len(self.reader.read(self.path)), 1)
            self.assertEqual(len(self.reader.read(self.path)), 1)
            self.assertEqual(len(self.reader.read(self.path)), 1)
        self.path.write_bytes(b"x" * 200 + b"\n" + message)
        self.reader.reset(self.path, at_end=False)
        with patch("relay_lab.logs.LINE_LIMIT", 100):
            self.assertEqual([e["kind"] for e in self.reader.read(self.path)], ["verack"])

    def test_unrelated_or_malformed_logs_cannot_invent_negotiation(self):
        for message in ("peer=1 supports staletip announcements with prefers_blocks=2",
                        "unknown feature advertised: peer=1 supports staletip announcements with prefers_blocks=1",
                        "received: feature (9 bytes) peer=x"):
            self.assertIsNone(self.reader.parse(line(message).decode()))
        self.assertIsNone(self.reader.parse("bad timestamp [net] sending version (103 bytes) peer=1"))


if __name__ == "__main__":
    unittest.main()
