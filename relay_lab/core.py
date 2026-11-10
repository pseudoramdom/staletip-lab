"""Own real node processes, serialize experiments, and publish observed state."""

import base64
import copy
import fcntl
import json
import queue
import re
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .networks import Regtest
from .wire import CaptureReader
from .logs import NetworkLogReader, rotate_log


class RPCError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class Node:
    def __init__(self, node_id, name, mode, datadir, binary, network, p2p_port, rpc_port,
                 public_network=False, configured_peers=None):
        self.id, self.name, self.mode = node_id, name, mode
        self.datadir, self.binary, self.network = Path(datadir), Path(binary), network
        self.p2p_port, self.rpc_port = p2p_port, rpc_port
        self.public_network = public_network
        self.configured_peers = list(configured_peers or [])
        self.desired_running = False
        self.process = None
        self.console = None
        self.generation = 0
        self.started_at = 0.0
        self.mining = {"enabled": False, "interval": 10.0}
        self.next_mine = 0.0
        self.capture = CaptureReader()
        self.log_reader = NetworkLogReader()
        self.records = {}
        self.status = "stopped"
        self.error = None
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @property
    def address(self):
        return "127.0.0.1:%d" % self.p2p_port

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    @property
    def chain_dir(self):
        return self.datadir / self.network.chain_directory

    def rpc(self, method, *params):
        try:
            cookie = (self.chain_dir / ".cookie").read_text().strip()
        except OSError as error:
            raise RPCError("%s RPC is not ready: %s" % (self.name, error)) from error
        body = json.dumps({"jsonrpc": "2.0", "id": "relay-lab", "method": method, "params": list(params)}).encode()
        request = urllib.request.Request("http://127.0.0.1:%d/" % self.rpc_port, data=body,
                                        headers={"Authorization": "Basic " + base64.b64encode(cookie.encode()).decode(),
                                                 "Content-Type": "application/json"})
        try:
            with self._http.open(request, timeout=10) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read())
            except (ValueError, UnicodeDecodeError):
                raise RPCError("%s RPC returned HTTP %d" % (self.name, error.code)) from error
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise RPCError("%s RPC: %s" % (self.name, error)) from error
        if value.get("error"):
            error = value["error"]
            raise RPCError(error.get("message", "RPC failed"), error.get("code"))
        return value.get("result")

    def start(self, cancelled):
        if self.running:
            return
        self.datadir.mkdir(parents=True, exist_ok=True)
        self.status, self.error = "starting", None
        self.generation += 1
        self.started_at = time.time()
        if self.network.public_peers:
            self.log_reader.reset(self.chain_dir / "debug.log", at_end=True)
        self.console = (self.datadir / "console.log").open("ab")
        args = [str(self.binary)] + self.network.arguments() + [
            "-datadir=" + str(self.datadir), "-server=1", "-daemon=0",
            "-port=%d" % self.p2p_port, "-bind=" + self.address,
            "-rpcport=%d" % self.rpc_port, "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
            "-discover=0", "-listenonion=0", "-natpmp=0",
            "-staletips=" + self.mode, "-debug=net",
            "-capturemessages=%d" % (not self.network.public_peers),
            "-dbcache=%d" % (256 if self.network.public_peers else 64),
        ]
        if not self.public_network:
            args += ["-connect=0", "-dnsseed=0", "-fixedseeds=0"]
        else:
            args += ["-dnsseed=1", "-maxconnections=16"]
        args += ["-addnode=" + peer for peer in self.configured_peers]
        if self.network.public_peers:
            args += ["-printtoconsole=0", "-logtimemicros=1"]
        try:
            self.process = subprocess.Popen(args, stdout=self.console, stderr=subprocess.STDOUT)
            startup_timeout = 180 if self.network.persistent else 30
            deadline = time.monotonic() + startup_timeout
            while time.monotonic() < deadline:
                if cancelled.is_set():
                    raise RuntimeError("Server is shutting down")
                if not self.running:
                    tail = (self.datadir / "console.log").read_text(errors="replace")[-2500:]
                    raise RuntimeError("%s exited during startup. %s" % (self.name, tail))
                try:
                    self.rpc("getblockcount")
                    self.status = "running"
                    return
                except RPCError:
                    time.sleep(0.1)
            raise RuntimeError("%s did not become RPC-ready within %d seconds" % (self.name, startup_timeout))
        except Exception as error:
            self.stop()
            self.status, self.error = "error", str(error)
            raise

    def stop(self):
        self.mining["enabled"] = False
        if self.process is not None:
            if self.running:
                try:
                    self.rpc("stop")
                except RPCError:
                    self.process.terminate()
                try:
                    self.process.wait(timeout=120 if self.network.persistent else 15)
                except subprocess.TimeoutExpired:
                    if self.network.persistent:
                        self.process.terminate()
                        try:
                            self.process.wait(timeout=30)
                        except subprocess.TimeoutExpired:
                            self.process.kill()
                            self.process.wait(timeout=5)
                    else:
                        self.process.kill()
                        self.process.wait(timeout=5)
            else:
                self.process.wait()
        self.process = None
        if self.console is not None:
            self.console.close()
            self.console = None
        self.status = "stopped"


class Lab:
    MAX_NODES = 8
    WINDOW = 80

    def __init__(self, bin_dir, run_dir, network=None, observers=None):
        self.observer = observers is not None
        self.bin_dir = Path(bin_dir).expanduser().resolve() if bin_dir is not None else None
        self.run_dir = Path(run_dir).resolve()
        self.binary = self.bin_dir / "bitcoind" if self.bin_dir is not None else None
        if not self.observer and (self.binary is None or not self.binary.is_file()):
            raise ValueError("bitcoind not found in %s" % self.bin_dir)
        self.network = network or Regtest()
        if self.observer and self.network.name not in ("testnet4", "signet"):
            raise ValueError("Observer mode supports testnet4 and signet")
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._profile_lock = None
        if self.network.persistent:
            self._profile_lock = (self.run_dir / ".controller.lock").open("a")
            try:
                fcntl.flock(self._profile_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                self._profile_lock.close()
                raise ValueError("This profile is already open in another lab server") from error
        self._nodes = {}
        self._edges = {}
        self._peer_sessions = {}
        self._peer_history = {}
        self._negotiation = {}
        self._pending_captures = []
        self._used_ports = set()
        self._events = deque(maxlen=1200)
        self._jobs = deque(maxlen=40)
        self._sequence = 0
        self._queue = queue.Queue(maxsize=32)
        self._lock = threading.RLock()
        self._closed = threading.Event()
        self._resetting = False
        self._event_file = (self.run_dir / "events.jsonl").open("a", buffering=1)
        self._state = {"session": self._session(self.run_dir),
                       "nodes": [], "blocks": [], "links": [], "external_peers": [], "events": [], "jobs": []}
        try:
            if self.observer:
                from .observer import ObserverNode
                if not isinstance(observers, list) or not 1 <= len(observers) <= self.MAX_NODES:
                    raise ValueError("Observer configuration requires 1–8 nodes")
                for index, config in enumerate(observers, 1):
                    node = ObserverNode("n%d" % index, config, self.network)
                    self._nodes[node.id] = node
                self._publish_controls()
            else:
                self._load_profile()
        except Exception:
            self._event_file.close()
            if self._profile_lock:
                self._profile_lock.close()
            raise
        (self.run_dir / "session.json").write_text(json.dumps(self._state["session"], indent=2))
        self._thread = threading.Thread(target=self._work, name="relay-lab", daemon=True)
        self._thread.start()

    def _session(self, run_dir):
        return {"network": self.network.name, "run_dir": str(run_dir),
                "binary": str(self.binary) if self.binary else None, "observer": self.observer, "started_at": time.time(),
                "window_blocks": self.WINDOW, "max_nodes": self.MAX_NODES,
                "reset_supported": not self.network.persistent,
                "observation_id": secrets.token_hex(8),
                "observation_source": "debug-log" if self.network.public_peers else "capture",
                "capabilities": {**self.network.capabilities(), "management": not self.observer}}

    def snapshot(self):
        with self._lock:
            result = copy.deepcopy(self._state)
            result["events"] = copy.deepcopy(list(self._events))
            result["jobs"] = copy.deepcopy(list(self._jobs))
            result["server_time"] = time.time()
            return result

    @property
    def closed(self):
        return self._closed.is_set()

    def submit(self, action, params):
        allowed = {"bootstrap", "add_node", "start_node", "stop_node", "set_mode", "connect", "disconnect",
                   "mine", "miner", "fork", "stop_all", "reset", "set_peers", "clear_events"}
        if action not in allowed:
            raise ValueError("Unknown action: %s" % action)
        if self._closed.is_set():
            raise ValueError("The laboratory is shutting down")
        self._check_action(action, params)
        job = {"id": secrets.token_hex(6), "action": action, "status": "queued", "message": "Waiting to run",
               "created_at": time.time()}
        with self._lock:
            if self._resetting:
                raise ValueError("The lab is resetting; wait for the empty workspace")
            if action == "reset":
                if params.get("confirmed") is not True:
                    raise ValueError("Confirm Reset lab before resetting")
                if params.get("session") != self._state["session"]["run_dir"]:
                    raise ValueError("The session has changed; reopen the reset confirmation")
                if any(item["status"] in ("queued", "running") for item in self._jobs):
                    raise ValueError("Wait for the current operation to finish before resetting")
            try:
                self._queue.put_nowait((job, copy.deepcopy(params)))
            except queue.Full:
                raise ValueError("Too many queued operations; wait for the current work to finish")
            self._jobs.append(job)
            if action == "reset":
                self._resetting = True
        return copy.deepcopy(job)

    def close(self):
        self._closed.set()
        self._thread.join(timeout=self.MAX_NODES * 155 + 30 if self.network.persistent else 90)
        if self._thread.is_alive():
            raise RuntimeError("Node worker did not finish shutting down")

    def _event(self, kind, summary, **fields):
        with self._lock:
            self._sequence += 1
            event = {"id": self._sequence, "time": time.time(), "kind": kind, "summary": summary,
                     "node": None, "peer": None, "source": None, "target": None,
                     "direction": "local", "size": 0, "details": {}}
            event.update(fields)
            self._events.append(event)
            if self.network.persistent and self._event_file.tell() >= 8 * 1024 * 1024:
                self._event_file.close()
                (self.run_dir / "events.jsonl").replace(self.run_dir / "events.jsonl.1")
                self._event_file = (self.run_dir / "events.jsonl").open("a", buffering=1)
            self._event_file.write(json.dumps(event) + "\n")
        return event

    def _progress(self, job, message):
        with self._lock:
            job["message"] = message

    def _work(self):
        next_poll = 0.0
        try:
            while not self._closed.is_set():
                try:
                    job, params = self._queue.get(timeout=0.15)
                except queue.Empty:
                    job = None
                if job:
                    with self._lock:
                        job.update(status="running", started_at=time.time(), message="Running " + job["action"])
                    try:
                        result = self._perform(job["action"], params, job)
                        self._save_profile()
                        with self._lock:
                            job.update(status="done", result=copy.deepcopy(result), message="Completed", finished_at=time.time())
                    except Exception as error:
                        with self._lock:
                            job.update(status="error", error=str(error), message=str(error), finished_at=time.time())
                        self._event("error", str(error), details={"action": job["action"]})
                    finally:
                        if job["status"] == "error":
                            try:
                                self._save_profile()
                            except OSError as error:
                                self._event("error", "Could not save the node profile: " + str(error))
                        if job["action"] == "reset":
                            with self._lock:
                                self._resetting = False
                        self._queue.task_done()
                    next_poll = 0.0
                self._mine_due()
                if time.monotonic() >= next_poll:
                    try:
                        self._refresh()
                    except Exception as error:
                        self._event("error", "State refresh failed: " + str(error))
                    next_poll = time.monotonic() + (2 if self.network.public_peers else 0.65)
        finally:
            for node in reversed(list(self._nodes.values())):
                try:
                    if not self.observer:
                        node.stop()
                except Exception as error:
                    self._event("error", "Could not stop %s: %s" % (node.name, error))
            self._event_file.close()
            if self._profile_lock:
                self._profile_lock.close()

    def _check_action(self, action, params):
        if self.observer and action != "clear_events":
            raise ValueError("Observer mode cannot change or control existing nodes")
        if not self.network.mining and (action in ("mine", "miner", "fork", "bootstrap") or "seed_from" in params):
            raise ValueError("Mining, fork creation, and starter chains are available only on regtest")
        if self.network.persistent and action == "reset":
            raise ValueError("Testnet4 retains its downloaded chain; use Clear timeline or stop nodes instead")
        if action == "set_peers" and not self.network.public_peers:
            raise ValueError("Public peer settings are available only on testnet4")
        if action in ("add_node", "set_peers"):
            public, peers = self._peer_settings(params.get("public_network", self.network.public_peers), params.get("peers", []))
            if not self.network.public_peers and (public or peers):
                raise ValueError("Public peer settings are available only on testnet4")

    @staticmethod
    def _peer_settings(public_network, peers):
        if not isinstance(public_network, bool):
            raise ValueError("Public network discovery must be a boolean")
        if not isinstance(peers, list) or len(peers) > 16:
            raise ValueError("Supply up to 16 peers as host:port addresses")
        result = []
        for peer in peers:
            if not isinstance(peer, str) or not 1 <= len(peer) <= 255 or any(c.isspace() for c in peer):
                raise ValueError("Peer addresses must use host:port, or [IPv6]:port")
            try:
                parsed = urlsplit("//" + peer)
                if (not parsed.hostname or not parsed.port or parsed.username or parsed.password
                        or parsed.path or parsed.query or parsed.fragment):
                    raise ValueError()
            except ValueError:
                raise ValueError("Peer addresses must use host:port, or [IPv6]:port")
            if peer not in result:
                result.append(peer)
        return public_network, result

    def _save_profile(self):
        if self.observer or not self.network.persistent:
            return
        profile = {"version": 1, "network": self.network.name,
                   "nodes": [{"id": node.id, "name": node.name, "mode": node.mode,
                              "public_network": node.public_network, "peers": node.configured_peers,
                              "p2p_port": node.p2p_port, "rpc_port": node.rpc_port,
                              "running": node.desired_running} for node in self._nodes.values()],
                   "links": [{"a": edge["a"], "b": edge["b"]} for edge in self._edges.values()]}
        temporary = self.run_dir / "profile.json.tmp"
        temporary.write_text(json.dumps(profile, indent=2))
        temporary.replace(self.run_dir / "profile.json")

    def _load_profile(self):
        path = self.run_dir / "profile.json"
        if not self.network.persistent or not path.exists():
            return
        profile = json.loads(path.read_text())
        if profile.get("version") != 1 or profile.get("network") != self.network.name:
            raise ValueError("The saved profile has an unsupported version or network")
        nodes = profile.get("nodes", [])
        if not isinstance(nodes, list) or len(nodes) > self.MAX_NODES:
            raise ValueError("The saved profile contains too many nodes")
        for item in nodes:
            node_id = item["id"]
            if not isinstance(node_id, str) or not re.fullmatch(r"n[1-9][0-9]*", node_id) or node_id in self._nodes:
                raise ValueError("The saved profile contains an invalid node ID")
            name = item["name"]
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
                raise ValueError("The saved profile contains an invalid node name")
            public, peers = self._peer_settings(item.get("public_network", True), item.get("peers", []))
            ports = [self._integer(item[key], 1, 65535, "Saved port") for key in ("p2p_port", "rpc_port")]
            if ports[0] == ports[1] or any(port in self._used_ports for port in ports):
                raise ValueError("The saved profile contains duplicate ports")
            self._used_ports.update(ports)
            node = Node(node_id, name, self._mode(item["mode"]), self.run_dir / "nodes" / node_id,
                        self.binary, self.network, *ports, public_network=public, configured_peers=peers)
            node.desired_running = item.get("running") is True
            self._nodes[node_id] = node
        for edge in profile.get("links", []):
            a, b = self._node(edge["a"]), self._node(edge["b"])
            if a.id == b.id:
                raise ValueError("The saved profile contains a self-connection")
            edge_id = self._edge_id(a.id, b.id)
            self._edges[edge_id] = {"id": edge_id, "a": a.id, "b": b.id, "since": time.time()}
        self._publish_controls()
        if any(node.desired_running for node in self._nodes.values()):
            job = {"id": secrets.token_hex(6), "action": "resume_profile", "status": "queued",
                   "message": "Resuming saved testnet4 nodes", "created_at": time.time()}
            self._jobs.append(job)
            self._queue.put_nowait((job, {}))

    @staticmethod
    def _mode(value):
        if value not in ("none", "headers", "blocks"):
            raise ValueError("Stale-tip mode must be none, headers, or blocks")
        return value

    @staticmethod
    def _integer(value, low, high, name):
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError("%s must be an integer between %d and %d" % (name, low, high))
        return value

    def _node(self, node_id, running=False):
        if node_id not in self._nodes:
            raise ValueError("Unknown node: %s" % node_id)
        node = self._nodes[node_id]
        if running and not node.running:
            raise ValueError("%s is not running" % node.name)
        return node

    def _port(self):
        for _ in range(50):
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            if port not in self._used_ports:
                self._used_ports.add(port)
                return port
        raise RuntimeError("Could not reserve a local node port")

    def _create(self, name, mode, helper=False, public_network=None, peers=None):
        if not helper and len(self._nodes) >= self.MAX_NODES:
            raise ValueError("This laboratory supports up to %d visible nodes" % self.MAX_NODES)
        name = str(name).strip()
        if not name or len(name) > 40:
            raise ValueError("Node names must contain 1–40 characters")
        public, peers = self._peer_settings(self.network.public_peers if public_network is None else public_network, peers or [])
        if not self.network.public_peers and (public or peers):
            raise ValueError("Public peer settings are available only on testnet4")
        node_id = "fork-" + secrets.token_hex(4) if helper else "n%d" % (max((int(n[1:]) for n in self._nodes), default=0) + 1)
        datadir = self.run_dir / ("forks" if helper else "nodes") / node_id
        node = Node(node_id, name, self._mode(mode), datadir, self.binary, self.network, self._port(), self._port(),
                    public_network=public, configured_peers=peers)
        node.desired_running = True
        if not helper:
            self._nodes[node_id] = node
            self._save_profile()
        node.start(self._closed)
        if not helper:
            self._event("node", "%s started in %s mode" % (name, mode), node=node.id)
            self._publish_controls()
        return node

    def _publish_controls(self):
        with self._lock:
            old = {item["id"]: item for item in self._state["nodes"]}
            values = []
            for node in self._nodes.values():
                item = old.get(node.id, {"id": node.id, "height": 0, "best_hash": None, "ibd": True,
                                         "peers": [], "staletips": [], "tips": [], "blocks": {}})
                item.update(name=node.name, mode=node.mode, running=node.running, status=node.status,
                            mining=copy.deepcopy(node.mining), error=node.error,
                            p2p_port=node.p2p_port, rpc_port=node.rpc_port, datadir=str(node.datadir),
                            public_network=node.public_network, configured_peers=list(node.configured_peers))
                if not node.running:
                    item["peers"] = []
                values.append(item)
            self._state["nodes"] = values

    def _accept(self, destination, raw):
        result = destination.rpc("submitblock", raw)
        if result not in (None, "inconclusive", "duplicate", "duplicate-inconclusive"):
            raise RuntimeError("%s rejected block: %s" % (destination.name, result))

    def _raw_block(self, block, preferred):
        candidates = [preferred] + [n for n in self._nodes.values() if n.id != preferred.id and n.running]
        for node in candidates:
            try:
                return node.rpc("getblock", block, 0)
            except RPCError:
                continue
        raise ValueError("No running node has the full block data for %s" % block)

    def _seed(self, destination, source, parent, job):
        path = []
        block = parent
        while block:
            if self._closed.is_set():
                raise RuntimeError("Server is shutting down")
            header = source.rpc("getblockheader", block)
            if header["height"] == 0:
                break
            path.append(block)
            if len(path) > 2000:
                raise ValueError("Fork preparation is limited to 2000 ancestor blocks in this regtest lab")
            block = header.get("previousblockhash")
        for index, block in enumerate(reversed(path)):
            if self._closed.is_set():
                raise RuntimeError("Server is shutting down")
            self._progress(job, "Preparing %s: ancestor %d of %d" % (destination.name, index + 1, len(path)))
            self._accept(destination, self._raw_block(block, source))

    @staticmethod
    def _edge_id(a, b):
        return "--".join(sorted((a, b)))

    def _connect(self, a_id, b_id):
        a, b = self._node(a_id, True), self._node(b_id, True)
        if a.id == b.id:
            raise ValueError("A node cannot connect to itself")
        edge = self._edge_id(a.id, b.id)
        # All lab connections are explicit one-shot outbound connections. No
        # automatic retries can silently heal a user-created partition.
        for local, remote in ((a, b), (b, a)):
            for peer in local.rpc("getpeerinfo"):
                if not peer.get("inbound") and peer.get("addr") == remote.address:
                    self._edges.setdefault(edge, {"id": edge, "a": remote.id, "b": local.id,
                                                  "since": max(local.started_at, peer.get("conntime", 0))})
                    return {"id": edge}
        since = time.time()
        b.rpc("addnode", a.address, "onetry")
        self._edges[edge] = {"id": edge, "a": a.id, "b": b.id, "since": since}
        self._event("connection", "%s connects to %s" % (b.name, a.name), source=b.id, target=a.id)
        return {"id": edge}

    def _restore(self, node_id):
        for edge in list(self._edges.values()):
            if node_id in (edge["a"], edge["b"]):
                if self._node(edge["a"]).running and self._node(edge["b"]).running:
                    self._connect(edge["a"], edge["b"])

    def _disconnect(self, a_id, b_id):
        a, b = self._node(a_id), self._node(b_id)
        edge_id = self._edge_id(a.id, b.id)
        self._refresh()
        for local, remote in ((a, b), (b, a)):
            if not local.running:
                continue
            for peer in local.rpc("getpeerinfo"):
                session = self._peer_sessions.get((local.id, local.generation, peer["id"]))
                if peer.get("addr") == remote.address or (session and session["remote"] == remote.id):
                    try:
                        local.rpc("disconnectnode", "", peer["id"])
                    except RPCError as error:
                        if error.code != -29:
                            raise
        self._edges.pop(edge_id, None)
        self._event("connection", "%s disconnected from %s" % (a.name, b.name), source=a.id, target=b.id)
        return {"id": edge_id}

    def _perform(self, action, p, job):
        self._check_action(action, p)
        if action == "resume_profile":
            for node in self._nodes.values():
                if node.desired_running:
                    self._progress(job, "Resuming " + node.name)
                    try:
                        node.start(self._closed)
                    except Exception as error:
                        self._event("error", "Could not resume %s: %s" % (node.name, error), node=node.id)
            for node in self._nodes.values():
                if node.running:
                    self._restore(node.id)
            self._publish_controls()
            return {"nodes": list(self._nodes)}
        if action == "clear_events":
            for node in self._nodes.values():
                if self.network.public_peers:
                    log_path = node.log_file if self.observer else node.chain_dir / "debug.log"
                    if log_path:
                        node.log_reader.reset(log_path, at_end=True)
                else:
                    node.capture.read(node.chain_dir / "message_capture")
            with self._lock:
                self._events.clear()
                self._pending_captures.clear()
                self._state["session"]["observation_id"] = secrets.token_hex(8)
            return {}
        if action == "reset":
            return self._reset(job)
        if action == "bootstrap":
            if self._nodes:
                raise ValueError("The starter creates a fresh lab. Add individual nodes to this existing session instead.")
            count = self._integer(p.get("count", 3), 2, 6, "Node count")
            mode = self._mode(p.get("mode", "headers"))
            first = self._create("A", mode)
            hashes = self.network.mine(first, 5, secrets.token_hex(32))
            for index in range(1, count):
                node = self._create(chr(65 + index), mode)
                self._seed(node, first, hashes[-1], job)
            ids = list(self._nodes)
            for a, b in zip(ids, ids[1:]):
                self._connect(a, b)
            self._event("scenario", "Created %d nodes with a shared five-block chain" % count)
            return {"nodes": ids}
        if action == "add_node":
            source_id = p.get("seed_from")
            source = None
            if self.network.mining:
                source = self._node(source_id, True) if source_id else next((n for n in self._nodes.values() if n.running), None)
            node = self._create(p.get("name", chr(65 + len(self._nodes))), p.get("mode", "headers"),
                                public_network=p.get("public_network"), peers=p.get("peers", []))
            if source:
                self._seed(node, source, source.rpc("getbestblockhash"), job)
            return {"id": node.id}
        if action in ("start_node", "stop_node", "set_mode"):
            node = self._node(p.get("id"))
            mode = self._mode(p.get("mode")) if action == "set_mode" else node.mode
            node.desired_running = action != "stop_node"
            self._save_profile()
            previous_miner = copy.deepcopy(node.mining)
            if action == "set_mode":
                self._refresh()
                node.stop()
                node.mode = mode
                self._save_profile()
            if action == "stop_node":
                self._refresh()
                node.stop()
                self._event("node", "%s stopped" % node.name, node=node.id)
            else:
                node.start(self._closed)
                self._restore(node.id)
                if action == "set_mode":
                    node.mining = previous_miner
                    node.next_mine = time.monotonic() + node.mining["interval"]
                self._event("node", "%s started in %s mode" % (node.name, node.mode), node=node.id)
            self._publish_controls()
            return {"id": node.id}
        if action == "set_peers":
            node = self._node(p.get("id"))
            public, peers = self._peer_settings(p.get("public_network"), p.get("peers", []))
            running = node.running
            if running:
                self._refresh()
                node.stop()
            node.public_network, node.configured_peers = public, peers
            self._save_profile()
            if running:
                node.start(self._closed)
                self._restore(node.id)
            self._publish_controls()
            self._event("connection", "%s peer settings updated" % node.name, node=node.id)
            return {"id": node.id}
        if action == "connect":
            return self._connect(p.get("a"), p.get("b"))
        if action == "disconnect":
            return self._disconnect(p.get("a"), p.get("b"))
        if action == "mine":
            node = self._node(p.get("id"), True)
            count = self._integer(p.get("count", 1), 1, 100, "Block count")
            hashes = self.network.mine(node, count, secrets.token_hex(32))
            self._event("mining", "%s mined %d block%s" % (node.name, count, "" if count == 1 else "s"),
                        node=node.id, source=node.id, details={"hashes": hashes})
            return {"hashes": hashes}
        if action == "miner":
            node = self._node(p.get("id"), True)
            interval = p.get("interval", 10)
            if isinstance(interval, bool) or not isinstance(interval, (float, int)) or not 2 <= interval <= 3600:
                raise ValueError("Mining interval must be between 2 and 3600 seconds")
            if not isinstance(p.get("enabled"), bool):
                raise ValueError("Mining enabled must be a boolean")
            node.mining = {"enabled": p["enabled"], "interval": interval}
            node.next_mine = time.monotonic() + interval
            self._publish_controls()
            self._event("mining", "%s automatic mining %s" % (node.name, "started" if p["enabled"] else "paused"), node=node.id)
            return {"id": node.id, "mining": node.mining}
        if action == "fork":
            source = self._node(p.get("source"), True)
            length = self._integer(p.get("length", 1), 1, 20, "Fork length")
            parent = p.get("parent")
            if not isinstance(parent, str) or len(parent) != 64:
                raise ValueError("Select a parent block for the fork")
            source.rpc("getblockheader", parent)
            recipient_ids = p.get("recipients", [source.id])
            if not isinstance(recipient_ids, list) or not recipient_ids:
                raise ValueError("Choose at least one initial recipient")
            recipients = [self._node(node_id, True) for node_id in dict.fromkeys(recipient_ids)]
            helper = None
            try:
                self._progress(job, "Starting an isolated fork miner")
                helper = self._create("Private fork miner", "none", helper=True)
                self._seed(helper, source, parent, job)
                self._progress(job, "Mining %d blocks on the private branch" % length)
                hashes = self.network.mine(helper, length, secrets.token_hex(32))
                for block in hashes:
                    raw = helper.rpc("getblock", block, 0)
                    for destination in recipients:
                        self._accept(destination, raw)
                result = {"parent": parent, "tip": hashes[-1], "hashes": hashes, "recipients": recipient_ids}
                self._event("fork", "Created a %d-block fork and revealed it to %s" % (length, ", ".join(n.name for n in recipients)),
                            node=source.id, source=source.id, details=result)
                return result
            finally:
                if helper is not None:
                    helper.stop()
        if action == "stop_all":
            self._refresh()
            for node in self._nodes.values():
                node.desired_running = False
            self._save_profile()
            for node in reversed(list(self._nodes.values())):
                node.stop()
            self._publish_controls()
            self._event("node", "Stopped all nodes")
            return {}
        raise ValueError("Unsupported action")

    def _reset(self, job):
        previous = self.run_dir
        run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
        fresh = previous.parent / run_id
        fresh.mkdir(mode=0o700)
        session = self._session(fresh)
        (fresh / "session.json").write_text(json.dumps(session, indent=2))
        event_file = (fresh / "events.jsonl").open("a", buffering=1)
        try:
            self._progress(job, "Stopping all nodes and miners before resetting")
            for node in self._nodes.values():
                node.mining["enabled"] = False
            for node in reversed(list(self._nodes.values())):
                node.stop()
            self._refresh()
            self._event("reset", "Session ended by a confirmed reset", details={"next_session": str(fresh)})
            (previous / "final-state.json").write_text(json.dumps(self.snapshot(), indent=2))
            # The switch is atomic for readers. Fresh capture readers and peer
            # identities prevent old messages leaking into reused node IDs.
            with self._lock:
                self._event_file.close()
                self._event_file = event_file
                self.run_dir = fresh
                self._nodes.clear()
                self._edges.clear()
                self._peer_sessions.clear()
                self._peer_history.clear()
                self._negotiation.clear()
                self._pending_captures.clear()
                self._used_ports.clear()
                self._events.clear()
                self._jobs.clear()
                self._jobs.append(job)
                self._state = {"session": session, "nodes": [], "blocks": [], "links": [], "events": [], "jobs": []}
            return {"previous_session": str(previous), "session": str(fresh)}
        except Exception:
            event_file.close()
            raise

    def _mine_due(self):
        if self._resetting or not self.network.mining:
            return
        for node in self._nodes.values():
            if self._closed.is_set():
                return
            if node.running and node.mining["enabled"] and time.monotonic() >= node.next_mine:
                try:
                    hashes = self.network.mine(node, 1, secrets.token_hex(32))
                    self._event("mining", "%s mined a block" % node.name, node=node.id,
                                source=node.id, details={"hashes": hashes})
                except Exception as error:
                    node.mining["enabled"] = False
                    self._event("error", "%s mining paused: %s" % (node.name, error), node=node.id)
                node.next_mine = time.monotonic() + node.mining["interval"]

    def _collect(self, node):
        info, network = node.rpc("getblockchaininfo"), node.rpc("getnetworkinfo")
        peers = node.rpc("getpeerinfo")
        active_tip = {"hash": info["bestblockhash"], "height": info["blocks"], "branchlen": 0, "status": "active"}
        # Header synchronization can lead validation by hundreds of thousands
        # of blocks. Walking from that header tip would block all controls.
        tips_available = not (self.network.public_peers and info["initialblockdownload"])
        tips = node.rpc("getchaintips", 1000) if tips_available else [active_tip]
        cutoff = max(0, info["blocks"] - self.WINDOW + 1)
        records, active, validated, tip_status = {}, set(), set(), {}
        shown_tips = sorted(tips, key=lambda item: (item["status"] != "active", -item["height"]))[:64]
        for tip in shown_tips:
            if tip["height"] < cutoff or tip["height"] > info["blocks"] + self.WINDOW:
                continue
            block = tip["hash"]
            tip_status[block] = tip["status"]
            visited = set()
            while block and block not in visited and len(visited) <= self.WINDOW and len(records) < self.WINDOW * 10:
                visited.add(block)
                cached = node.records.get(block)
                if cached is None:
                    header = node.rpc("getblockheader", block)
                    cached = {"hash": block, "parent": header.get("previousblockhash"),
                              "height": header["height"], "time": header["time"],
                              "difficulty": header.get("difficulty"), "have_data": False}
                if cached["height"] < cutoff:
                    break
                if block not in records:
                    record = dict(cached)
                    if self.network.public_peers and tip["status"] == "active" and not info.get("pruned", False):
                        record["have_data"] = True
                    if not record["have_data"]:
                        try:
                            record["size"] = node.rpc("getblock", block, 1).get("size")
                            record["have_data"] = True
                        except RPCError as error:
                            if error.code not in (-1, -5):
                                raise
                    records[block] = record
                if tip["status"] == "active":
                    active.add(block)
                if tip["status"] in ("active", "valid-fork"):
                    validated.add(block)
                block = cached["parent"]
        for block, record in records.items():
            record["active"] = block in active
            record["validity"] = "invalid" if tip_status.get(block) == "invalid" else (
                "validated" if block in validated else "headers-valid")
        node.records = records
        local_features = network.get("localfeatures")
        mode = node.mode
        if self.observer and local_features is not None:
            feature = local_features.get("BIP332")
            preference = feature.get("prefers_blocks") if feature else None
            mode = ("blocks" if preference else "headers") if isinstance(preference, bool) else (
                "none" if feature is None else "unknown")
        stale_tips = []
        if tips_available and mode in ("headers", "blocks"):
            stale_tips = node.rpc("getchaintips", 1000, True)
        node.status, node.error = "running", None
        return {"id": node.id, "name": node.name, "mode": mode, "running": True,
                "status": "running", "height": info["blocks"], "best_hash": info["bestblockhash"],
                "ibd": info["initialblockdownload"], "mining": copy.deepcopy(node.mining),
                "headers": info.get("headers", info["blocks"]),
                "verification_progress": info.get("verificationprogress", 0),
                "size_on_disk": info.get("size_on_disk", 0), "pruned": info.get("pruned", False),
                "public_network": node.public_network, "configured_peers": list(node.configured_peers),
                "peers": peers, "localfeatures": local_features,
                "staletips": stale_tips,
                "tips": tips, "tips_available": tips_available,
                "blocks": records, "error": None, "p2p_port": node.p2p_port,
                "rpc_port": node.rpc_port, "datadir": None if self.observer else str(node.datadir)}

    def _map_peers(self, states):
        listeners = {node.address: node.id for node in self._nodes.values()}
        outbound = {}
        for state in states:
            for peer in state.get("peers", []):
                if not peer.get("inbound") and peer.get("addrbind"):
                    outbound[(peer["addrbind"], peer["addr"])] = state["id"]
        live = {}
        for state in states:
            node = self._nodes[state["id"]]
            for peer in state.get("peers", []):
                remote = listeners.get(peer["addr"]) if not peer["inbound"] else outbound.get((peer["addr"], node.address))
                key = (node.id, node.generation, peer["id"])
                external = remote is None and self.network.public_peers
                if external:
                    remote = "external:%s:%d:%d" % key
                peer["remote_node"] = remote
                if remote:
                    edge = self._edges.get(self._edge_id(node.id, remote))
                    since = max(node.started_at, peer.get("conntime", 0), edge["since"] if edge else 0)
                    session = {"node": node.id, "remote": remote, "address": peer["addr"], "key": key, "since": since,
                               "external": external}
                    if external:
                        session["peer"] = {"id": remote, "name": peer["addr"], "address": peer["addr"],
                                           "node": node.id, "peer_id": peer["id"], "version": peer.get("version"),
                                           "subver": peer.get("subver", ""), "inbound": peer["inbound"], "connected": True}
                    self._peer_sessions[key] = session
                    history = self._peer_history.setdefault((node.id, peer["addr"]), [])
                    if not any(previous["key"] == key for previous in history):
                        history.append(session)
                        del history[:-20]
                    live[key] = session
                    negotiation = self._negotiation.setdefault(key, {"advertised": None, "received": None, "version": False,
                                                                    "verack": False, "sent_version": False, "sent_verack": False})
                    negotiation["local_features"] = state.get("localfeatures")
                    negotiation["peer_features"] = peer.get("features")
        if self.network.public_peers:
            recent = sorted(self._peer_sessions, key=lambda key: self._peer_sessions[key]["since"], reverse=True)[:256]
            keep = set(live) | set(recent)
            self._peer_sessions = {key: value for key, value in self._peer_sessions.items() if key in keep}
            self._negotiation = {key: value for key, value in self._negotiation.items() if key in keep}
            self._peer_history = {address: retained for address, history in self._peer_history.items()
                                  if (retained := [session for session in history if session["key"] in keep])}
        return live

    def _capture_events(self):
        for node in self._nodes.values():
            try:
                if self.network.public_peers:
                    log_path = node.log_file if self.observer else node.chain_dir / "debug.log"
                    events = node.log_reader.read(log_path) if log_path else []
                    if node.running and not self.observer:
                        if rotate_log(node.chain_dir / "debug.log", node.process) and node.log_reader.lag_bytes:
                            self._event("observation_gap", "%s rotated a busy log before all messages could be read" % node.name,
                                        node=node.id, details={"unread_bytes": node.log_reader.lag_bytes})
                else:
                    events = node.capture.read(node.chain_dir / "message_capture")
                for event in events:
                    event["node"] = node.id
                    if "peer_id" in event:
                        event["generation"] = node.generation
                    self._pending_captures.append(event)
            except (OSError, ValueError) as error:
                self._event("error", "Capture read failed on %s: %s" % (node.name, error), node=node.id)
        pending = []
        for event in sorted(self._pending_captures, key=lambda item: item["time"]):
            if "peer_id" in event:
                candidate = self._peer_sessions.get((event["node"], event["generation"], event["peer_id"]))
                sessions = [candidate] if candidate else []
            else:
                sessions = self._peer_history.get((event["node"], event["peer_address"]), [])
            eligible = [session for session in sessions if session["since"] <= event["time"]]
            session = max(eligible, key=lambda item: item["since"]) if eligible else None
            if session is None and time.time() - event["time"] < 3:
                pending.append(event)
                continue
            remote = session["remote"] if session else None
            incoming = event["direction"] == "recv"
            event["peer"] = remote
            event["source"] = remote if incoming else event["node"]
            event["target"] = event["node"] if incoming else remote
            details, kind = event["details"], event["kind"]
            if session:
                negotiation = self._negotiation[session["key"]]
                if kind == "version":
                    negotiation["version" if incoming else "sent_version"] = True
                elif kind == "verack":
                    negotiation["verack" if incoming else "sent_verack"] = True
                elif kind == "feature" and details.get("feature") == "BIP332" and details.get("prefers_blocks") is not None:
                    negotiation["received" if incoming else "advertised"] = details["prefers_blocks"]
            node_name = self._nodes[event["node"]].name
            peer_name = self._nodes[remote].name if remote in self._nodes else (
                session["address"] if session else event.get("peer_address", "peer %s" % event.get("peer_id", "unknown")))
            description = "%s %s %s %s %s" % (node_name, "received" if incoming else "sent", kind,
                                               "from" if incoming else "to", peer_name)
            if kind == "staletip" and "header_count" in details:
                description += " · %d headers · blocks %s" % (details["header_count"], "available" if details["have_block"] else "unavailable")
            self._event(kind, description, **{key: value for key, value in event.items() if key != "kind"})
        self._pending_captures = pending[-2000:]

    def _refresh(self):
        states = []
        with self._lock:
            previous = {item["id"]: copy.deepcopy(item) for item in self._state["nodes"]}
        for node in self._nodes.values():
            if node.running or self.observer:
                try:
                    states.append(self._collect(node))
                    continue
                except (RPCError, OSError, ValueError) as error:
                    node.error = str(error)
                    node.status = "unavailable"
                    if self.observer:
                        node.available = False
            elif node.status == "running":
                node.status, node.error = "error", "Node process exited; inspect console.log in its datadir"
                node.mining["enabled"] = False
            state = previous.get(node.id, {"id": node.id, "height": 0, "best_hash": None, "ibd": True,
                                            "staletips": [], "tips": [], "blocks": {}})
            state.update(name=node.name, mode=node.mode, running=node.running, status=node.status,
                         error=node.error, peers=[], mining=copy.deepcopy(node.mining), p2p_port=node.p2p_port,
                         rpc_port=node.rpc_port, datadir=str(node.datadir),
                         public_network=node.public_network, configured_peers=list(node.configured_peers))
            states.append(state)
        for state in states:
            before = previous.get(state["id"], {}).get("blocks", {})
            after = state.get("blocks", {})
            if not state.get("running"):
                continue
            disconnected = sorted((block for block, record in before.items() if record.get("active")
                                   and block in after and not after[block].get("active")),
                                  key=lambda block: after[block]["height"])
            if disconnected:
                self._event("reorg", "%s reorganized away from %d block%s" % (
                    state["name"], len(disconnected), "" if len(disconnected) == 1 else "s"),
                    node=state["id"], details={"hashes": disconnected, "new_tip": state.get("best_hash"),
                                               "depth": len(disconnected)})
        live = self._map_peers(states)
        self._capture_events()
        links = {}
        for session in live.values():
            edge_id = self._edge_id(session["node"], session["remote"])
            a, b = sorted((session["node"], session["remote"]))
            link = links.setdefault(edge_id, {"id": edge_id, "a": a, "b": b, "connected": True, "negotiation": {}})
            link["negotiation"][session["node"]] = copy.deepcopy(self._negotiation[session["key"]])
        union = {}
        for state in states:
            for block, record in state["blocks"].items():
                union[block] = {key: record[key] for key in ("hash", "parent", "height", "time")}
        with self._lock:
            self._state.update(nodes=states, links=list(links.values()),
                               external_peers=[session["peer"] for session in live.values() if session.get("external")],
                               blocks=sorted(union.values(), key=lambda block: (block["height"], block["hash"])))
