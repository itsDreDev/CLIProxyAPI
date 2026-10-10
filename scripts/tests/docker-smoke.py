#!/usr/bin/env python3
"""Test a built Linux Docker image with an isolated profile and no provider accounts.

Add --browser to run the existing Playwright dashboard suite against the container.
That option requires gui npm dependencies and an installed Chromium browser.
Only this script's uniquely named container and temporary files are removed.
"""
import argparse
import base64
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


MANAGEMENT_KEY = "subscription-gui-e2e-management-key"
CLIENT_KEY = "subscription-gui-e2e-client-key"
ROOT = Path(__file__).resolve().parents[2]


def docker(*arguments):
    return subprocess.run(["docker", *arguments], check=True, capture_output=True, text=True).stdout


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def request(url, method="GET", body=None, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    data = None if body is None else json.dumps(body).encode()
    call = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(call, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        return response.status, dict(response.headers), raw


def api(origin, path, method="GET", body=None, key=MANAGEMENT_KEY):
    code, _, raw = request(origin + path, method, body, key)
    assert code == 200, f"Unexpected API status {code}: {path}"
    return json.loads(raw)


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.sources = []
        self.inline = []
        self.current = None

    def handle_starttag(self, tag, attributes):
        if tag == "script":
            source = dict(attributes).get("src")
            if source:
                self.sources.append(source)
            self.current = ""

    def handle_data(self, data):
        if self.current is not None:
            self.current += data

    def handle_endtag(self, tag):
        if tag == "script":
            if self.current:
                self.inline.append(self.current)
            self.current = None


def dashboard(origin):
    code, headers, body = request(origin + "/subscriptions/")
    assert code == 200 and b"Subscription Desk" in body, "Bundled Next dashboard is missing"
    policy = next((value for name, value in headers.items() if name.lower() == "content-security-policy"), "")
    assert "script-src 'self'" in policy and "style-src 'self'" in policy and "frame-ancestors 'none'" in policy, policy
    assert "'unsafe-inline'" not in policy and "'unsafe-eval'" not in policy, policy
    scripts = Scripts()
    scripts.feed(body.decode())
    assert scripts.sources and scripts.inline, "Next bootstrap scripts are missing"
    for script in scripts.inline:
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        assert "'sha256-" + digest + "'" in policy, "Inline Next bootstrap is not authorized by its exact CSP hash"
    for source in scripts.sources:
        assert source.startswith("/subscriptions/_next/"), "Dashboard must use its embedded Next assets"
        assert request(urllib.parse.urljoin(origin, source))[0] == 200, "Embedded Next asset is missing"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="subscription-desk:local")
    parser.add_argument("--browser", action="store_true")
    options = parser.parse_args()
    def terminate(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    assert docker("info", "--format", "{{.OSType}}").strip() == "linux", "Smoke test requires a Linux Docker host"
    name = "subscription-smoke-" + uuid.uuid4().hex[:12]
    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="subscription-docker-smoke-") as temporary:
        profile = Path(temporary)
        auths = profile / "auths"
        auths.mkdir()
        (auths / ".smoke-volume-marker").write_text("isolated test profile\n")
        config = profile / "config.yaml"
        config.write_text(f"""config-version: 8
server: {{host: '127.0.0.1', port: {port}, trusted-proxies: [], tls: {{enable: false}}}}
management: {{secret-key: '{MANAGEMENT_KEY}', allow-remote: false, disable-control-panel: false, disable-auto-update-panel: true}}
access: {{api-keys: ['{CLIENT_KEY}']}}
oauth: {{auth-dir: '/CLIProxyAPI/profile/auths'}}
routing: {{strategy: round-robin}}
""")
        config.chmod(0o600)

        def launch():
            docker("run", "--detach", "--name", name, "--network", "host", "--user", f"{os.getuid()}:{os.getgid()}", "--env", "HOME=/tmp", "--init", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL", "--mount", f"type=bind,src={profile},dst=/CLIProxyAPI/profile", options.image, "./CLIProxyAPI", "--config", "/CLIProxyAPI/profile/config.yaml", "--local-model")

        def ready():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    if request(origin + "/subscriptions/")[0] == 200:
                        return
                except OSError:
                    pass
                inspection = json.loads(docker("inspect", name))[0]
                assert inspection["State"]["Running"], "Container exited before readiness"
                time.sleep(0.1)
            raise AssertionError("Container dashboard did not become ready")

        def persistence(expected):
            ready()
            assert api(origin, "/v8/management/config/routing/strategy") == expected["routing"]["strategy"]
            actual = api(origin, "/v8/management/config")
            assert actual["access"]["api-keys"] == expected["access"]["api-keys"], "Client keys did not persist"
            for key in actual["access"]["api-keys"]:
                assert request(origin + "/v1/models", key=key)[0] == 200
            assert docker("exec", name, "cat", "/CLIProxyAPI/profile/auths/.smoke-volume-marker") == "isolated test profile\n"
            stored = docker("exec", name, "cat", "/CLIProxyAPI/profile/config.yaml")
            assert MANAGEMENT_KEY not in stored and "$2" in stored, "Stored management key must remain hashed"

        try:
            launch()
            ready()
            inspected = json.loads(docker("inspect", name))[0]
            assert inspected["HostConfig"]["NetworkMode"] == "host"
            assert not inspected["HostConfig"].get("PortBindings"), "Host-network deployment must not publish extra ports"
            dashboard(origin)
            for key in (None, "incorrect-smoke-key"):
                assert request(origin + "/v8/management/credentials", key=key)[0] == 401
                assert request(origin + "/v1/models", key=key)[0] == 401
            assert request(origin + "/v8/management/credentials", key=CLIENT_KEY)[0] == 401
            assert request(origin + "/v1/models", key=MANAGEMENT_KEY)[0] == 401
            assert api(origin, "/v8/management/credentials")["files"] == []
            current = api(origin, "/v8/management/config")
            assert current["server"]["host"] == "127.0.0.1"
            assert current["management"]["allow-remote"] is False
            assert not current["server"].get("trusted-proxies")
            assert request(origin + "/v1/models", key=CLIENT_KEY)[0] == 200
            print("PASS Docker host networking, loopback configuration, separate management/client authentication, embedded Next assets and exact CSP hashes", flush=True)
            if options.browser:
                environment = {**os.environ, "SUBSCRIPTION_GUI_BASE_URL": origin}
                subprocess.run(["npm", "run", "test:e2e", "--prefix", "gui"], cwd=ROOT, env=environment, check=True)
            else:
                api(origin, "/v8/management/config/routing/strategy", "PUT", "fill-first")
                api(origin, "/v8/management/config/access/api-keys", "PUT", [CLIENT_KEY, "docker-smoke-generated-client-key"])
            expected = api(origin, "/v8/management/config")
            docker("restart", name)
            persistence(expected)
            docker("rm", "--force", name)
            launch()
            persistence(expected)
            dashboard(origin)
            print("PASS Docker restart and replacement preserve routing, client keys, hashed management authentication and mounted auth data", flush=True)
            print("No real provider credentials or actual Tailnet access were used.")
        except BaseException:
            try:
                print("Isolated container diagnostics:\n" + docker("logs", "--tail", "60", name))
            except subprocess.CalledProcessError:
                pass
            raise
        finally:
            subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
