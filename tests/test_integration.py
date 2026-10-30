"""Optional real-node workflow: STALETIP_INTEGRATION=1 python3 -m unittest discover -s tests.

The default test run skips this suite. It requires the BIP332 branch binaries and
permission to bind localhost ports; no other network connections are needed.
"""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from relay_lab.config import find_bin_dir


@unittest.skipUnless(os.environ.get("STALETIP_INTEGRATION") == "1", "set STALETIP_INTEGRATION=1 to run real regtest nodes")
class RegtestWorkflowTests(unittest.TestCase):
    def setUp(self):
        from relay_lab.core import Lab

        binary_dir = find_bin_dir()
        self.temp = tempfile.TemporaryDirectory(prefix="staletip-lab-integration-")
        self.addCleanup(self.temp.cleanup)
        self.lab = Lab(bin_dir=binary_dir, run_dir=Path(self.temp.name) / "first-session")
        # Cleanup order matters: stop owned processes before removing datadirs,
        # including when an assertion or a timed-out action aborts the workflow.
        self.addCleanup(self.lab.close)

    @staticmethod
    def node(state, node_id):
        return next(node for node in state["nodes"] if node["id"] == node_id)

    @staticmethod
    def describe(state):
        return json.dumps({
            "nodes": [{key: node.get(key) for key in ("id", "name", "running", "status", "height", "best_hash", "error", "mining", "staletips")}
                      for node in state.get("nodes", [])],
            "links": state.get("links", []),
            "jobs": state.get("jobs", [])[-5:],
            "events": state.get("events", [])[-8:],
        }, indent=2)

    def wait_for(self, predicate, description, timeout=60):
        deadline = time.monotonic() + timeout
        state = self.lab.snapshot()
        while time.monotonic() < deadline:
            state = self.lab.snapshot()
            if predicate(state):
                return state
            time.sleep(0.1)
        self.fail("Timed out waiting for %s.\n%s" % (description, self.describe(state)))

    def action(self, action_name, **params):
        submitted = self.lab.submit(action_name, params)
        job_id = submitted["id"]

        def finished(state):
            jobs = [job for job in state.get("jobs", []) if job["id"] == job_id]
            if not jobs:
                return False
            job = jobs[0]
            if job["status"] == "error":
                self.fail("%s failed: %s\n%s" % (action_name, job.get("error", job.get("message")), self.describe(state)))
            return job["status"] == "done"

        state = self.wait_for(finished, "%s job %s" % (action_name, job_id))
        return next(job for job in state["jobs"] if job["id"] == job_id)

    def test_three_node_relay_mining_and_lifecycle(self):
        self.action("bootstrap", count=3, mode="headers")
        state = self.wait_for(
            lambda s: len(s.get("nodes", [])) == 3 and all(n.get("height") == 5 and n.get("running") for n in s["nodes"]),
            "three running nodes on the shared five-block chain",
        )
        source, middle, downstream = [node["id"] for node in state["nodes"]]
        winner = self.node(state, source)["best_hash"]
        self.assertTrue(all(node["best_hash"] == winner for node in state["nodes"]))

        def negotiated_line(snapshot):
            links = [link for link in snapshot.get("links", []) if link.get("connected")]
            if len(links) != 2:
                return False
            if {frozenset((link["a"], link["b"])) for link in links} != {
                    frozenset((source, middle)), frozenset((middle, downstream))}:
                return False
            for link in links:
                for node_id in (link["a"], link["b"]):
                    negotiation = link.get("negotiation", {}).get(node_id, {})
                    if (negotiation.get("advertised") is not False
                            or negotiation.get("received") is not False
                            or not negotiation.get("version") or not negotiation.get("verack")):
                        return False
            return True

        state = self.wait_for(negotiated_line, "captured BIP332 headers-mode negotiation on exactly A--B--C")
        source_blocks = self.node(state, source)["blocks"]
        parent = next(block["hash"] for block in source_blocks.values() if block["height"] == 2 and block["active"])
        fork_job = self.action("fork", source=source, parent=parent, length=2, recipients=[source])
        hashes = fork_job["result"]["hashes"]
        stale_tip = fork_job["result"]["tip"]
        self.assertEqual(len(hashes), 2)
        self.assertEqual(hashes[-1], stale_tip)

        def onward_headers(snapshot):
            for node_id in (middle, downstream):
                node = self.node(snapshot, node_id)
                if not any(tip["hash"] == stale_tip and tip["have_block"] is False for tip in node.get("staletips", [])):
                    return False
                if not all(h in node.get("blocks", {}) and node["blocks"][h].get("have_data") is False for h in hashes):
                    return False
            return any(event.get("kind") == "staletip" and event.get("direction") == "recv"
                       and event.get("source") == middle and event.get("target") == downstream
                       and event.get("details", {}).get("tip") == stale_tip
                       for event in snapshot.get("events", []))

        state = self.wait_for(onward_headers, "C receiving the stale headers through B, with neither recipient downloading blocks")
        self.assertTrue(all(node["best_hash"] == winner for node in state["nodes"]))

        for node_id in (middle, downstream):
            self.action("set_mode", id=node_id, mode="blocks")
            state = self.wait_for(
                lambda s, current=node_id: all(self.node(s, current).get("blocks", {}).get(h, {}).get("have_data") is True for h in hashes),
                "both stale blocks downloaded by %s after blocks-mode renegotiation" % node_id,
            )
            self.assertEqual(self.node(state, node_id)["best_hash"], winner)
            self.assertTrue(any(tip["hash"] == stale_tip and tip["have_block"] is True
                                for tip in self.node(state, node_id)["staletips"]))

        self.action("miner", id=source, enabled=True, interval=2)
        self.wait_for(lambda s: self.node(s, source)["height"] >= 6, "automatic miner producing a new block")
        self.action("miner", id=source, enabled=False, interval=2)
        self.wait_for(lambda s: self.node(s, source)["mining"]["enabled"] is False, "automatic miner pausing")
        # Allow the final completed mining operation to reach the snapshot, then
        # observe longer than one mining interval to verify it really paused.
        time.sleep(1.5)
        paused_height = self.node(self.lab.snapshot(), source)["height"]
        time.sleep(3)
        self.assertEqual(self.node(self.lab.snapshot(), source)["height"], paused_height)

        self.action("stop_node", id=downstream)
        self.wait_for(lambda s: self.node(s, downstream)["running"] is False, "C stopping")
        self.action("start_node", id=downstream)
        self.wait_for(
            lambda s: self.node(s, downstream)["running"] and all(
                self.node(s, downstream).get("blocks", {}).get(h, {}).get("have_data") is True for h in hashes),
            "C restarting with its downloaded stale blocks intact",
        )

        observer_job = self.action("add_node", name="D", mode="none", seed_from=source)
        observer = observer_job["result"]["id"]

        def observer_seeded(snapshot):
            node = self.node(snapshot, observer)
            active = [block for block in node.get("blocks", {}).values() if block["active"] and block["height"] > 0]
            return (node["running"] and node["best_hash"] == self.node(snapshot, source)["best_hash"]
                    and len(active) == node["height"] and all(block["have_data"] for block in active))

        self.wait_for(observer_seeded, "new none-mode node D seeded with the complete active chain")
        self.action("connect", a=source, b=observer)

        def observer_connected(snapshot):
            for link in snapshot.get("links", []):
                if link.get("connected") and {link["a"], link["b"]} == {source, observer}:
                    own = link.get("negotiation", {}).get(observer, {})
                    remote = link.get("negotiation", {}).get(source, {})
                    return (own.get("version") and own.get("verack") and remote.get("verack")
                            and own.get("advertised") is None and own.get("received") is False
                            and remote.get("advertised") is False and remote.get("received") is None)
            return False

        state = self.wait_for(observer_connected, "D completing its handshake without advertising BIP332")
        expected_peers = {}
        for node_id, peer_id in ((source, observer), (observer, source)):
            expected_peers[node_id] = [peer["id"] for peer in self.node(state, node_id)["peers"] if peer.get("remote_node") == peer_id]
            self.assertEqual(len(expected_peers[node_id]), 1)
        self.assertFalse(any(event.get("kind") == "feature" and event.get("source") == observer
                             and event.get("details", {}).get("feature") == "BIP332"
                             for event in state["events"]))

        # Connecting an existing undirected pair in reverse must preserve the
        # same peer sockets. Observe subsequent polls to catch a queued second
        # connection that has not appeared when the action first completes.
        self.action("connect", a=observer, b=source)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            state = self.lab.snapshot()
            for node_id, peer_id in ((source, observer), (observer, source)):
                peers = [peer["id"] for peer in self.node(state, node_id)["peers"] if peer.get("remote_node") == peer_id]
                self.assertEqual(peers, expected_peers[node_id], "Reverse connect created or replaced a peer socket")
            time.sleep(0.1)

        self.action("disconnect", a=source, b=observer)

        def observer_disconnected(snapshot):
            return (not any(link.get("connected") and {link["a"], link["b"]} == {source, observer}
                            for link in snapshot.get("links", []))
                    and not self.node(snapshot, observer)["peers"]
                    and not any(peer.get("remote_node") == observer for peer in self.node(snapshot, source)["peers"]))

        self.wait_for(observer_disconnected, "D's actual peer connection disappearing after disconnect")
        self.action("connect", a=source, b=observer)
        self.wait_for(observer_connected, "D reconnecting and completing another none-mode handshake")
        self.action("stop_all")
        self.wait_for(lambda s: all(node["running"] is False for node in s["nodes"]), "all owned nodes stopping")

    def test_confirmed_reset_retains_archive_and_starts_fresh(self):
        self.action("bootstrap", count=2, mode="headers")
        state = self.wait_for(lambda s: len(s["nodes"]) == 2 and all(n["height"] == 5 for n in s["nodes"]),
                              "the initial reset-test network")
        old_dir = Path(state["session"]["run_dir"])
        source = state["nodes"][0]["id"]
        winner = state["nodes"][0]["best_hash"]
        self.action("miner", id=source, enabled=True, interval=3600)
        with self.assertRaisesRegex(ValueError, "Confirm Reset lab"):
            self.lab.submit("reset", {})
        with self.assertRaisesRegex(ValueError, "session has changed"):
            self.lab.submit("reset", {"confirmed": True, "session": "an older session"})
        self.assertEqual(self.lab.snapshot()["session"]["run_dir"], str(old_dir))

        old_nodes = list(self.lab._nodes.values())
        reset = self.action("reset", confirmed=True, session=str(old_dir))
        state = self.lab.snapshot()
        new_dir = Path(state["session"]["run_dir"])
        self.assertNotEqual(old_dir, new_dir)
        self.assertTrue(new_dir.is_dir())
        self.assertTrue(all(not node.running and not node.mining["enabled"] for node in old_nodes))
        for key in ("nodes", "blocks", "links", "events"):
            self.assertEqual(state[key], [], key + " must be empty after reset")
        self.assertEqual([job["id"] for job in state["jobs"]], [reset["id"]])
        archive = json.loads((old_dir / "final-state.json").read_text())
        self.assertEqual(len(archive["nodes"]), 2)
        self.assertTrue(all(not node["running"] and not node["mining"]["enabled"] for node in archive["nodes"]))
        self.assertTrue((old_dir / "nodes" / source / "regtest" / "blocks").is_dir())
        self.assertTrue((old_dir / "events.jsonl").is_file())
        with self.assertRaisesRegex(ValueError, "session has changed"):
            self.lab.submit("reset", {"confirmed": True, "session": str(old_dir)})

        self.action("bootstrap", count=2, mode="blocks")
        state = self.wait_for(lambda s: len(s["nodes"]) == 2 and all(n["height"] == 5 for n in s["nodes"]),
                              "a new experiment after reset")
        self.assertNotEqual(state["nodes"][0]["best_hash"], winner)
        self.assertTrue(all(node["mode"] == "blocks" and not node["staletips"] for node in state["nodes"]))
        self.assertTrue(all(Path(node["datadir"]).parent.parent == new_dir for node in state["nodes"]))


if __name__ == "__main__":
    unittest.main()
