"""Read-only RPC connections to Bitcoin nodes owned by another service."""

import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from .core import Node, RPCError


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ObserverNode(Node):
    READ_METHODS = frozenset({"getblockchaininfo", "getnetworkinfo", "getpeerinfo",
                              "getchaintips", "getblockheader", "getblock", "uptime"})

    def __init__(self, node_id, config, network):
        if not isinstance(config, dict):
            raise ValueError("Each observer node must be an object")
        name = config.get("name", node_id)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
            raise ValueError("Observer names must contain 1–40 characters")
        url = config.get("rpc_url", "")
        if not isinstance(url, str):
            raise ValueError("rpc_url must be an HTTP or HTTPS URL")
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("rpc_url must be an HTTP or HTTPS node URL without credentials, query, or wallet path")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        cookie = config.get("cookie_file")
        user_env, password_env = config.get("rpc_user_env"), config.get("rpc_password_env")
        if bool(cookie) == bool(user_env or password_env) or (not cookie and not (user_env and password_env)):
            raise ValueError("Provide cookie_file or both rpc_user_env and rpc_password_env")
        for value in (cookie, user_env, password_env, config.get("log_file"), config.get("p2p_address")):
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ValueError("Observer paths, environment names, and addresses must be nonempty strings")
        super().__init__(node_id, name.strip(), "unknown", Path("."), Path("."), network, 0, port)
        self.rpc_url = url
        self.cookie_file = Path(cookie).expanduser() if cookie else None
        self.user_env, self.password_env = user_env, password_env
        self.log_file = Path(config["log_file"]).expanduser() if config.get("log_file") else None
        self.p2p_address = config.get("p2p_address", "observer:" + node_id)
        self.available = False
        self.last_uptime = None
        self.started_at = time.time()
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        if self.log_file:
            self.log_reader.reset(self.log_file, at_end=True)

    @property
    def address(self):
        return self.p2p_address

    @property
    def running(self):
        return self.available

    def start(self, cancelled):
        raise ValueError("Observer mode cannot start an external node")

    def stop(self):
        pass

    def rpc(self, method, *params):
        if method not in self.READ_METHODS:
            raise ValueError("Observer mode forbids RPC method: " + method)
        try:
            if self.cookie_file:
                credentials = self.cookie_file.read_text().strip()
            else:
                credentials = os.environ[self.user_env] + ":" + os.environ[self.password_env]
        except (OSError, KeyError) as error:
            raise RPCError("%s RPC authentication is unavailable: %s" % (self.name, error)) from error
        body = json.dumps({"jsonrpc": "2.0", "id": "staletip-observer", "method": method, "params": list(params)}).encode()
        request = urllib.request.Request(self.rpc_url, data=body, headers={
            "Authorization": "Basic " + base64.b64encode(credentials.encode()).decode(),
            "Content-Type": "application/json"})
        try:
            with self._http.open(request, timeout=5) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read())
                if not isinstance(value, dict) or not value.get("error"):
                    raise RPCError("%s RPC returned HTTP %d" % (self.name, error.code))
            except (ValueError, UnicodeDecodeError):
                raise RPCError("%s RPC returned HTTP %d" % (self.name, error.code)) from error
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise RPCError("%s RPC unavailable: %s" % (self.name, error)) from error
        if not isinstance(value, dict):
            raise RPCError("Invalid RPC response")
        if value.get("error"):
            error = value["error"]
            raise RPCError(error.get("message", "RPC failed"), error.get("code"))
        result = value.get("result")
        if method == "getblockchaininfo":
            if result.get("chain") != self.network.name:
                raise RPCError("%s is on %s; expected %s" % (self.name, result.get("chain"), self.network.name))
            uptime = self.rpc("uptime")
            if not self.available or (self.last_uptime is not None and uptime < self.last_uptime):
                self.generation += 1
                self.started_at = time.time()
                self.records.clear()
                self.was_active.clear()
            self.last_uptime = uptime
            self.available = True
        return result
