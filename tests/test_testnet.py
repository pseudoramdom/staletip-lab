"""Testnet4 policies and optional local-only monitoring lifecycle tests."""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from relay_lab.networks import Testnet4


class LabAssertions:
    def wait_for(self, lab, predicate, description, timeout=45):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = lab.snapshot()
            if predicate(state):
                return state
            time.sleep(0.05)
        self.fail("Timed out waiting for %s: %r" % (description, lab.snapshot()))

    def action(self, lab, action_name, expect_error=False, **params):
        submitted = lab.submit(action_name, params)
        job_id = submitted["id"]
        state = self.wait_for(lab, lambda s: any(
            j["id"] == job_id and j["status"] in ("done", "error") for j in s["jobs"]), action_name)
        job = next(j for j in state["jobs"] if j["id"] == job_id)
        self.assertEqual(job["status"], "error" if expect_error else "done", job)
        return job

    @staticmethod
    def node(state, node_id):
        return next(node for node in state["nodes"] if node["id"] == node_id)


class TestnetPolicyTests(LabAssertions, unittest.TestCase):
    def setUp(self):
        from relay_lab.core import Lab

        self.temp = tempfile.TemporaryDirectory(prefix="staletip-testnet-policy-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bin_dir = root / "bin"
        self.bin_dir.mkdir()
        (self.bin_dir / "bitcoind").touch()
        self.run_dir = root / "profile"
        self.lab = Lab(self.bin_dir, self.run_dir, network=Testnet4())
        self.addCleanup(self.lab.close)

    def test_monitoring_policy_rejects_experiment_actions(self):
        session = self.lab.snapshot()["session"]
        self.assertEqual(session["network"], "testnet4")
        self.assertTrue(session["capabilities"]["public_peers"])
        self.assertTrue(session["capabilities"]["persistent"])
        for capability in ("mining", "forks", "bootstrap"):
            self.assertFalse(session["capabilities"][capability])
        self.assertFalse(session["reset_supported"])
        for action in ("mine", "miner", "fork", "bootstrap", "reset"):
            with self.subTest(action=action), self.assertRaises(ValueError):
                self.lab.submit(action, {"confirmed": True, "session": str(self.run_dir)})
        with self.assertRaises(ValueError):
            self.lab.submit("add_node", {"name": "A", "seed_from": "n1"})
        self.assertEqual(self.lab.snapshot()["jobs"], [])
        self.assertEqual(self.lab.snapshot()["nodes"], [])

    def test_settings_validate_before_starting_a_process(self):
        from relay_lab.core import Node

        invalid = [
            {"public_network": "false", "peers": []},
            {"public_network": False, "peers": "127.0.0.1:48333"},
            {"public_network": False, "peers": ["https://example.com:48333"]},
            {"public_network": False, "peers": ["user@example.com:48333"]},
            {"public_network": False, "peers": ["example.com:0"]},
            {"public_network": False, "peers": ["example.com:65536"]},
            {"public_network": False, "peers": ["example .com:48333"]},
            {"public_network": False, "peers": ["127.0.0.1:48333"] * 17},
        ]
        with mock.patch.object(Node, "start") as start:
            for settings in invalid:
                with self.subTest(settings=settings):
                    try:
                        self.action(self.lab, "add_node", expect_error=True, name="Invalid", **settings)
                    except ValueError:
                        pass
                    start.assert_not_called()
                    self.assertEqual(self.lab.snapshot()["nodes"], [])

    def test_profile_has_one_owner_and_clear_only_changes_observations(self):
        from relay_lab.core import Lab

        with self.assertRaises((RuntimeError, ValueError, OSError)):
            duplicate = Lab(self.bin_dir, self.run_dir, network=Testnet4())
            self.addCleanup(duplicate.close)
        original = self.lab.snapshot()["session"]
        self.lab._event("test", "An observation from this session")
        self.action(self.lab, "clear_events")
        state = self.lab.snapshot()
        self.assertEqual(state["session"]["run_dir"], original["run_dir"])
        self.assertNotEqual(state["session"]["observation_id"], original["observation_id"])
        self.assertEqual(state["events"], [])

    def test_chain_tip_eligibility_is_separate_from_block_availability(self):
        from relay_lab.core import Node, RPCError

        node = Node("n1", "A", "blocks", self.run_dir / "node", self.lab.binary,
                    Testnet4(), 18400, 18401)
        tips = [{"hash": "block1000", "height": 1000, "branchlen": 0, "status": "active"}]
        for name, status in (("header", "headers-only"), ("pruned", "valid-fork"),
                             ("ineligible", "valid-headers"), ("unknown", "headers-only")):
            tips.append({"hash": name + "999", "height": 999, "branchlen": 1,
                         "fork_point": "block998", "status": status})
        # A known child makes old800 disappear from the ordinary chain tips.
        old = {"hash": "old800", "height": 800, "branchlen": 1,
               "fork_point": "block799", "status": "valid-fork"}
        tips.append(dict(old, hash="child801", height=801, branchlen=2, status="invalid"))
        relayable = [tips[1], tips[2], old]

        def rpc(method, *params):
            if method == "getblockchaininfo":
                return {"blocks": 1000, "headers": 1000, "bestblockhash": "block1000",
                        "initialblockdownload": False, "pruned": True}
            if method == "getnetworkinfo":
                return {"localfeatures": {"BIP332": {"prefers_blocks": True}}}
            if method == "getpeerinfo":
                return []
            if method == "getchaintips":
                if params == (1000, True):
                    return relayable
                self.assertEqual(params, (1000,))
                return tips
            if method == "getblockheader":
                block = params[0]
                height = int(block.lstrip("abcdefghijklmnopqrstuvwxyz"))
                return {"height": height, "previousblockhash": "block%d" % (height - 1), "time": height}
            if method == "getblock":
                if params[0] in ("header999", "pruned999", "unknown999"):
                    raise RPCError("Block data unavailable", -1)
                return {"size": 285}
            self.fail("Unexpected RPC: " + method)

        node.rpc = rpc
        state = self.lab._collect(node)
        self.assertTrue(state["tips_available"])
        self.assertEqual({tip["hash"] for tip in state["staletips"]}, {"header999", "pruned999", "old800"})
        self.assertEqual(state["localfeatures"], {"BIP332": {"prefers_blocks": True}})
        self.assertFalse(state["blocks"]["header999"]["have_data"])
        self.assertFalse(state["blocks"]["pruned999"]["have_data"])
        self.assertEqual(state["blocks"]["pruned999"]["validity"], "validated")
        self.assertTrue(state["blocks"]["ineligible999"]["have_data"])
        self.assertNotIn("old800", {tip["hash"] for tip in state["tips"]})
        self.assertNotIn("old800", state["blocks"])
        self.assertTrue(all("have_block" not in tip for tip in state["staletips"]))

    def test_initial_sync_bounds_graph_to_validated_window(self):
        from relay_lab.core import Node

        node = Node("n1", "A", "headers", self.run_dir / "node", self.lab.binary,
                    Testnet4(), 18400, 18401)
        calls = []

        def rpc(method, *params):
            calls.append(method)
            if method == "getblockchaininfo":
                return {"blocks": 1000, "headers": 1_000_000, "bestblockhash": "block1000",
                        "initialblockdownload": True, "verificationprogress": 0.001,
                        "size_on_disk": 123456, "pruned": False}
            if method == "getnetworkinfo":
                return {"localfeatures": {}}
            if method == "getpeerinfo":
                return []
            if method == "getblockheader":
                height = int(params[0].removeprefix("block"))
                return {"height": height, "previousblockhash": "block%d" % (height - 1), "time": height}
            self.fail("Initial sync unexpectedly requested %s" % method)

        node.rpc = rpc
        state = self.lab._collect(node)
        self.assertFalse(state["tips_available"])
        self.assertEqual(state["headers"], 1_000_000)
        self.assertEqual(state["verification_progress"], 0.001)
        self.assertEqual(len(state["blocks"]), self.lab.WINDOW)
        self.assertTrue(all(b["active"] and b["height"] <= 1000 for b in state["blocks"].values()))
        self.assertLessEqual(calls.count("getblockheader"), self.lab.WINDOW + 1)


@unittest.skipUnless(os.environ.get("STALETIP_INTEGRATION") == "1",
                     "set STALETIP_INTEGRATION=1 to run local-only real testnet4 nodes")
class TestnetMonitoringTests(LabAssertions, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="staletip-testnet-integration-")
        self.addCleanup(self.temp.cleanup)
        from relay_lab.config import find_bin_dir

        self.bin_dir = find_bin_dir()
        self.labs = []
        self.addCleanup(self.stop_labs)

    def stop_labs(self):
        for lab in reversed(self.labs):
            if not lab.closed:
                lab.close()

    def open_lab(self, name):
        from relay_lab.core import Lab

        lab = Lab(self.bin_dir, Path(self.temp.name) / name, network=Testnet4())
        self.labs.append(lab)
        return lab

    def test_local_monitoring_negotiation_and_persistent_restart(self):
        peer_lab = self.open_lab("external-peer")
        peer = self.action(peer_lab, "add_node", name="External", mode="blocks",
                           public_network=False, peers=[])["result"]["id"]
        peer_state = self.wait_for(peer_lab, lambda s: s["nodes"] and s["nodes"][0]["running"],
                                   "local-only external peer")
        peer_address = "127.0.0.1:%d" % self.node(peer_state, peer)["p2p_port"]

        lab = self.open_lab("monitor")
        first = self.action(lab, "add_node", name="A", mode="headers", public_network=False,
                            peers=[])["result"]["id"]
        second = self.action(lab, "add_node", name="B", mode="none", public_network=False,
                             peers=[])["result"]["id"]
        self.action(lab, "connect", a=first, b=second)
        self.action(lab, "set_peers", id=first, public_network=False, peers=[peer_address])

        def observed_external(snapshot):
            for external in snapshot.get("external_peers", []):
                if external["node"] != first or external["address"] != peer_address:
                    continue
                for link in snapshot["links"]:
                    if {link["a"], link["b"]} == {first, external["id"]}:
                        negotiation = link["negotiation"].get(first, {})
                        return (link["connected"] and negotiation.get("received") is True
                                and negotiation.get("version") and negotiation.get("verack"))
            return False

        state = self.wait_for(lab, observed_external, "observed BIP332 preference from the external peer")
        genesis = "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043"
        for node in state["nodes"]:
            self.assertEqual(node["best_hash"], genesis)
            self.assertTrue(node["ibd"])
            self.assertEqual(node["headers"], 0)
            self.assertFalse(node["public_network"])
            self.assertFalse(node["mining"]["enabled"])
            self.assertIn("verification_progress", node)
            self.assertIn("size_on_disk", node)
            self.assertIn("pruned", node)
        external = next(p for p in state["external_peers"] if p["node"] == first and p["address"] == peer_address)
        link = next(link for link in state["links"] if {link["a"], link["b"]} == {first, external["id"]})
        self.assertIsNone(link["negotiation"][first]["advertised"], "Log-only mode must not invent a sent preference")
        self.assertTrue(any(event["kind"] == "feature" and event.get("evidence") == "debug-log"
                            and event["details"].get("prefers_blocks") is True for event in state["events"]))

        original = {n["id"]: {key: n[key] for key in ("datadir", "p2p_port", "rpc_port")} for n in state["nodes"]}
        epoch = state["session"]["observation_id"]
        old_event_ids = {event["id"] for event in state["events"]}
        self.action(lab, "clear_events")
        state = lab.snapshot()
        self.assertNotEqual(state["session"]["observation_id"], epoch)
        self.assertTrue(old_event_ids.isdisjoint(event["id"] for event in state["events"]))
        self.assertEqual({n["id"] for n in state["nodes"]}, {first, second})
        self.assertTrue(all(n["running"] and n["best_hash"] == genesis for n in state["nodes"]))

        self.action(lab, "set_mode", id=first, mode="blocks")
        self.action(lab, "stop_node", id=second)
        lab.close()
        lab = self.open_lab("monitor")
        state = self.wait_for(lab, lambda s: len(s["nodes"]) == 2 and self.node(s, first)["running"]
                              and not self.node(s, second)["running"], "saved running and stopped node states")
        for node in state["nodes"]:
            self.assertEqual({key: node[key] for key in original[node["id"]]}, original[node["id"]])
            self.assertTrue((Path(node["datadir"]) / "testnet4" / "blocks").is_dir())
        self.assertEqual(self.node(state, first)["mode"], "blocks")
        self.assertEqual(self.node(state, first)["configured_peers"], [peer_address])
        self.wait_for(lab, observed_external, "external peer reconnection after reopening the profile")
        self.action(lab, "start_node", id=second)
        self.wait_for(lab, lambda s: any(link["connected"] and {link["a"], link["b"]} == {first, second}
                                       for link in s["links"]), "restored local topology after starting B")


if __name__ == "__main__":
    unittest.main()
