import http.client
import json
import threading
import unittest

from relay_lab.app import LabServer


class FakeLab:
    closed = False

    def snapshot(self):
        return {"nodes": [], "events": []}

    def submit(self, action, params):
        return {"id": 1, "action": action, "status": "queued", "params": params}


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = LabServer(("127.0.0.1", 0), FakeLab())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        result = response.status, response.read()
        conn.close()
        return result

    def test_state_and_queued_action(self):
        status, body = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["nodes"], [])
        status, body = self.request("POST", "/api/action", json.dumps({"action": "mine", "id": "A", "count": 2}),
                                    {"Content-Type": "application/json", "X-Lab-Request": "1"})
        self.assertEqual(status, 202)
        self.assertEqual(json.loads(body)["params"], {"id": "A", "count": 2})

    def test_browser_boundary_and_private_files(self):
        action = json.dumps({"action": "stop_all"})
        for headers in ({"Content-Type": "application/json"},
                        {"Content-Type": "application/json", "X-Lab-Request": "1", "Origin": "https://example.com"},
                        {"Content-Type": "application/json", "X-Lab-Request": "1", "Host": "example.com"}):
            self.assertEqual(self.request("POST", "/api/action", action, headers)[0], 403)
        self.assertEqual(self.request("GET", "/../runs/session/node0/regtest/.cookie")[0], 404)
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "example.com"})[0], 403)
        self.assertEqual(self.request("POST", "/api/action", "[]", {"Content-Type": "application/json", "X-Lab-Request": "1"})[0], 400)


if __name__ == "__main__":
    unittest.main()
