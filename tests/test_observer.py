"""Observe an existing RPC service without taking ownership of its lifecycle."""

import base64
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from relay_lab.core import Lab
from relay_lab.networks import Signet, Testnet4


class ExistingNode(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), RPCHandler)
        self.chain = "testnet4"
        self.cookie = "observer:initial-cookie"
        self.available = True
        self.calls = []
        self.uptime = 100
        self.tip = "11" * 32
        self.local_features = {}
        self.peers = []

    def result(self, method, params):
        if method == "getchaintips" and params == [1000, True]:
            assert "BIP332" in (self.local_features or {})
            return []
        return {
            "getblockchaininfo": {"chain": self.chain, "blocks": 0, "headers": 0,
                                   "bestblockhash": self.tip, "initialblockdownload": False,
                                   "verificationprogress": 1, "pruned": False},
            "getnetworkinfo": {"localfeatures": self.local_features, "connections": len(self.peers)},
            "getpeerinfo": self.peers,
            "getchaintips": [{"hash": self.tip, "height": 0, "branchlen": 0, "status": "active"}],
            "getblockheader": {"hash": self.tip, "height": 0, "time": 1},
            "getblock": {"hash": self.tip, "size": 285},
            "uptime": self.uptime,
        }.get(method)


class RPCHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append(value["method"])
        expected = "Basic " + base64.b64encode(self.server.cookie.encode()).decode()
        status = 503 if not self.server.available else 401 if self.headers.get("Authorization") != expected else 200
        data = json.dumps({"result": self.server.result(value["method"], value["params"]), "error": None, "id": value.get("id")}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="staletip-observer-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = ExistingNode()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.cookie_file = self.root / ".cookie"
        self.cookie_file.write_text(self.server.cookie)
        self.config = {"name": "Existing node", "rpc_url": "http://127.0.0.1:%d" % self.server.server_port,
                       "cookie_file": str(self.cookie_file)}
        self.labs = []
        self.addCleanup(self.close_labs)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def close_labs(self):
        for lab in self.labs:
            lab.close()

    def lab(self, network=None, run_dir=None):
        lab = Lab(bin_dir=None, run_dir=run_dir or self.root / ("session%d" % len(self.labs)),
                  network=network or Testnet4(), observers=[dict(self.config)])
        self.labs.append(lab)
        return lab

    def wait_for(self, lab, predicate):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = lab.snapshot()
            if predicate(state):
                return state
            time.sleep(0.05)
        self.fail("Observer did not reach expected state: %r" % lab.snapshot())

    def ready(self, lab):
        return self.wait_for(lab, lambda s: len(s["nodes"]) == 1 and s["nodes"][0].get("status") == "running")

    def test_attaches_to_both_networks_without_node_ownership(self):
        for network in (Testnet4(), Signet()):
            with self.subTest(network=network.name):
                self.server.chain = network.name
                with patch("relay_lab.core.subprocess.Popen") as spawn, patch("relay_lab.core.rotate_log") as rotate:
                    lab = self.lab(network)
                    state = self.ready(lab)
                    self.assertTrue(state["session"]["observer"])
                    self.assertFalse(state["session"]["capabilities"]["management"])
                    self.assertEqual(state["nodes"][0]["best_hash"], self.server.tip)
                    lab.close()
                    spawn.assert_not_called()
                    rotate.assert_not_called()
                node = lab._nodes["n1"]
                self.assertEqual(node.rpc("getblockchaininfo")["chain"], network.name)
        self.assertNotIn("stop", self.server.calls)

    def test_rpc_features_are_available_without_handshake_logs(self):
        self.server.local_features = {"BIP332": {"prefers_blocks": False}}
        self.server.peers = [{"id": 41, "addr": "192.0.2.1:48333", "inbound": False,
                              "conntime": 1, "version": 70017,
                              "features": {"BIP332": {"prefers_blocks": True}}}]
        lab = self.lab()
        for local, remote, mode in ((False, True, "headers"), (True, False, "blocks"), (None, None, "none")):
            with self.subTest(mode=mode):
                local_features = {"BIP332": {"prefers_blocks": local}} if local is not None else {}
                peer_features = {"BIP332": {"prefers_blocks": remote}} if remote is not None else {}
                self.server.local_features = local_features
                self.server.peers[0]["features"] = peer_features
                state = self.wait_for(lab, lambda s: s["links"] and s["nodes"][0]["mode"] == mode
                                      and s["links"][0]["negotiation"]["n1"]["peer_features"] == peer_features)
                negotiation = state["links"][0]["negotiation"]["n1"]
                self.assertEqual(negotiation["local_features"], local_features)
                self.assertEqual(negotiation["peer_features"], peer_features)
                self.assertIsNone(negotiation["advertised"])
                self.assertIsNone(negotiation["received"])
                self.assertFalse(negotiation["version"])
                self.assertFalse(negotiation["verack"])
                self.assertFalse(any(event["kind"] == "feature" for event in state["events"]))
        self.server.local_features = None
        self.server.peers[0].pop("features")
        state = self.wait_for(lab, lambda s: s["nodes"][0]["mode"] == "unknown")
        self.assertIsNone(state["links"][0]["negotiation"]["n1"]["peer_features"])

    def test_rejects_mutations_at_action_and_rpc_boundaries(self):
        lab = self.lab()
        self.ready(lab)
        for action in ("bootstrap", "add_node", "start_node", "stop_node", "set_mode", "connect",
                       "disconnect", "mine", "miner", "fork", "stop_all", "reset", "set_peers", "resume_profile"):
            with self.subTest(action=action):
                with self.assertRaises(ValueError):
                    lab.submit(action, {})
                with self.assertRaises(ValueError):
                    lab._perform(action, {}, {})
        node = lab._nodes["n1"]
        for method in ("stop", "setnetworkactive", "addnode", "logging", "invalidateblock", "submitblock"):
            with self.subTest(method=method), self.assertRaises(ValueError):
                node.rpc(method)
        self.assertTrue(set(self.server.calls).issubset({"getblockchaininfo", "getnetworkinfo", "getpeerinfo",
                                                       "getchaintips", "getblockheader", "getblock", "uptime"}))

    def test_cookie_replacement_and_rpc_outage_recover_without_restart(self):
        lab = self.lab()
        self.ready(lab)
        self.server.available = False
        self.wait_for(lab, lambda s: s["nodes"][0].get("status") == "unavailable")
        replacement = self.root / "new.cookie"
        self.server.cookie = "observer:replacement-cookie"
        replacement.write_text(self.server.cookie)
        replacement.replace(self.cookie_file)
        self.server.available = True
        self.ready(lab)
        self.assertNotIn("stop", self.server.calls)

    def test_wrong_chain_is_not_presented_as_selected_network(self):
        self.server.chain = "signet"
        lab = self.lab(Testnet4())
        state = self.wait_for(lab, lambda s: s["nodes"] and s["nodes"][0].get("error"))
        self.assertNotEqual(state["nodes"][0]["status"], "running")
        self.assertNotIn("getchaintips", self.server.calls)

    def test_external_logs_are_read_only_and_clear_does_not_touch_profile(self):
        log = self.root / "external-debug.log"
        log.write_text("Existing node's historical log\n")
        log.chmod(0o400)
        self.config["log_file"] = str(log)
        run_dir = self.root / "existing-profile"
        run_dir.mkdir()
        profile = run_dir / "profile.json"
        profile.write_text("This must not be read as a managed-node profile or overwritten.")
        with patch("relay_lab.core.rotate_log") as rotate, patch("relay_lab.core.subprocess.Popen") as spawn:
            lab = self.lab(run_dir=run_dir)
            state = self.ready(lab)
            observation_id = state["session"]["observation_id"]
            job = lab.submit("clear_events", {})
            self.wait_for(lab, lambda s: any(j["id"] == job["id"] and j["status"] == "done" for j in s["jobs"]))
            self.assertNotEqual(lab.snapshot()["session"]["observation_id"], observation_id)
            lab.close()
            rotate.assert_not_called()
            spawn.assert_not_called()
        self.assertEqual(log.read_text(), "Existing node's historical log\n")
        self.assertEqual(profile.read_text(), "This must not be read as a managed-node profile or overwritten.")
        self.assertEqual(self.cookie_file.read_text(), self.server.cookie)

    def test_environment_authentication_is_not_exported(self):
        self.config.pop("cookie_file")
        self.config.update(rpc_user_env="OBSERVER_TEST_RPC_USER", rpc_password_env="OBSERVER_TEST_RPC_PASSWORD")
        self.server.cookie = "observer:environment-secret"
        with patch.dict(os.environ, {"OBSERVER_TEST_RPC_USER": "observer", "OBSERVER_TEST_RPC_PASSWORD": "environment-secret"}):
            lab = self.lab()
            state = self.ready(lab)
            self.assertNotIn("environment-secret", json.dumps(state))
            self.assertNotIn("environment-secret", (lab.run_dir / "session.json").read_text())
            lab.close()

    def test_invalid_authentication_and_endpoint_configuration_are_rejected(self):
        from relay_lab.observer import ObserverNode

        invalid = [
            {"rpc_url": "http://user:password@127.0.0.1:48332"},
            {"rpc_url": "file:///tmp/rpc"},
            {"rpc_url": "http://127.0.0.1:48332/wallet/private"},
            {"cookie_file": None},
            {"rpc_user_env": "OBSERVER_TEST_RPC_USER", "rpc_password_env": "OBSERVER_TEST_RPC_PASSWORD"},
        ]
        for overrides in invalid:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                ObserverNode("n1", dict(self.config, **overrides), Testnet4())
        self.assertEqual(self.server.calls, [])


@unittest.skipUnless(os.environ.get("STALETIP_INTEGRATION") == "1",
                     "set STALETIP_INTEGRATION=1 to observe local-only real nodes")
class ExistingNodeIntegrationTests(unittest.TestCase):
    def test_observer_shutdown_leaves_existing_signet_and_testnet4_nodes_running(self):
        import socket

        from relay_lab.config import find_bin_dir
        from relay_lab.core import Node

        binary = find_bin_dir() / "bitcoind"
        with tempfile.TemporaryDirectory(prefix="staletip-existing-nodes-") as temporary:
            root = Path(temporary)
            for network in (Signet(), Testnet4()):
                with self.subTest(network=network.name):
                    with socket.socket() as p2p, socket.socket() as rpc:
                        p2p.bind(("127.0.0.1", 0))
                        rpc.bind(("127.0.0.1", 0))
                        p2p_port, rpc_port = p2p.getsockname()[1], rpc.getsockname()[1]
                    external = Node("external", "Existing node", "blocks", root / network.name,
                                    binary, network, p2p_port, rpc_port, public_network=False)
                    try:
                        external.start(threading.Event())
                        original_pid = external.process.pid
                        original_tip = external.rpc("getblockchaininfo")["bestblockhash"]
                        config = {"name": "Existing node", "rpc_url": "http://127.0.0.1:%d" % rpc_port,
                                  "cookie_file": str(external.chain_dir / ".cookie"),
                                  "log_file": str(external.chain_dir / "debug.log")}
                        lab = Lab(None, root / (network.name + "-observer"), network=network, observers=[config])
                        try:
                            deadline = time.monotonic() + 15
                            while time.monotonic() < deadline:
                                state = lab.snapshot()
                                if state["nodes"] and state["nodes"][0].get("best_hash") == original_tip:
                                    break
                                time.sleep(0.05)
                            else:
                                self.fail("Observer could not attach: %r" % lab.snapshot())
                        finally:
                            lab.close()
                        self.assertEqual(external.process.pid, original_pid)
                        self.assertIsNone(external.process.poll())
                        self.assertEqual(external.rpc("getblockchaininfo")["bestblockhash"], original_tip)
                    finally:
                        external.stop()
