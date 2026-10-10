#!/usr/bin/env python3
"""Optional Linux WebKit smoke test with real IPC and an isolated proxy profile."""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def request(url, method="GET", data=None, headers=None):
    encoded = None if data is None else json.dumps(data).encode()
    values = {"Content-Type": "application/json", **(headers or {})}
    call = urllib.request.Request(url, data=encoded, method=method, headers=values)
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def wait_until(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Native smoke condition did not become ready")


def stop_group(process):
    if process:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application", required=True)
    parser.add_argument("--driver", default="tauri-driver")
    parser.add_argument("--native-driver", default="WebKitWebDriver")
    parser.add_argument("--screenshot", default="/tmp/subscription-desk-native.png")
    options = parser.parse_args()
    config = json.loads((Path(__file__).parents[1] / "src-tauri/tauri.conf.json").read_text())
    driver = None
    display = None
    session = None
    with tempfile.TemporaryDirectory(prefix="subscription-native-smoke-") as temporary:
        temporary = Path(temporary)
        profile = temporary / "data" / config["identifier"] / "proxy"
        profile.mkdir(parents=True)
        port = free_port()
        key = "native-smoke-only-management-key"
        client_key = "native-smoke-only-client-key"
        (profile / "config.yaml").write_text(f"""config-version: 8
server: {{host: '127.0.0.1', port: {port}, trusted-proxies: [], tls: {{enable: false}}}}
management: {{secret-key: '{key}', allow-remote: false, disable-control-panel: false, disable-auto-update-panel: true}}
access: {{api-keys: ['{client_key}']}}
oauth: {{auth-dir: '{profile / 'auths'}'}}
routing: {{strategy: round-robin}}
""")
        environment = {name: value for name, value in os.environ.items() if not name.startswith(("PGSTORE_", "GITSTORE_", "OBJECTSTORE_"))}
        environment.update({"XDG_DATA_HOME": str(temporary / "data"), "XDG_CONFIG_HOME": str(temporary / "config"), "XDG_CACHE_HOME": str(temporary / "cache"), "TAURI_WEBVIEW_AUTOMATION": "true", "WEBKIT_DISABLE_COMPOSITING_MODE": "1"})
        bridge_port = free_port()
        native_port = free_port()
        driver_url = f"http://127.0.0.1:{bridge_port}"
        log_path = temporary / "driver.log"
        with log_path.open("w+") as log:
            try:
                display = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "1600x1100x24", "-nolisten", "tcp"], stdout=subprocess.PIPE, stderr=log, text=True, start_new_session=True)
                environment["DISPLAY"] = ":" + display.stdout.readline().strip()
                driver = subprocess.Popen(["dbus-run-session", "--", options.driver, "--port", str(bridge_port), "--native-port", str(native_port), "--native-driver", options.native_driver], stdout=log, stderr=log, env=environment, start_new_session=True)

                def ready():
                    try:
                        return request(driver_url + "/status")[0] == 200
                    except OSError:
                        return False
                wait_until(ready)
                code, opened = request(driver_url + "/session", "POST", {"capabilities": {"alwaysMatch": {"tauri:options": {"application": str(Path(options.application).resolve())}}}})
                assert code == 200, opened
                session = opened["value"]["sessionId"]
                # The intermediary disables retrying cancelled pooled HTTP requests.
                # Use the platform driver directly after Tauri maps launch capabilities.
                session_url = f"http://127.0.0.1:{native_port}/session/{session}"

                def execute(script, *arguments, asynchronous=False):
                    endpoint = "/execute/async" if asynchronous else "/execute/sync"
                    code, result = request(session_url + endpoint, "POST", {"script": script, "args": list(arguments)})
                    assert code == 200, result
                    return result["value"]

                def invoke(command):
                    return execute("const done=arguments[arguments.length-1];if(!window.__TAURI_INTERNALS__?.invoke){done({ok:false,error:'No native IPC bridge'});return;}window.__TAURI_INTERNALS__.invoke(arguments[0]).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));", command, asynchronous=True)

                wait_until(lambda: execute("return !!document.querySelector('#proxy-status')"))
                initial = invoke("get_status")
                assert initial["ok"] and initial["value"]["mode"] == "local", initial
                assert initial["value"]["config_path"] == str(profile / "config.yaml"), initial
                started = invoke("start_proxy")
                assert started["ok"] and started["value"]["running"] and started["value"]["owned"], started
                server_url = f"http://127.0.0.1:{port}"
                assert request(server_url + "/v8/management/credentials")[0] == 401
                assert request(server_url + "/v8/management/credentials", headers={"Authorization": "Bearer " + key})[0] == 200
                assert request(server_url + "/v1/models", headers={"Authorization": "Bearer " + client_key})[0] == 200
                assert invoke("copy_management_key")["ok"]
                clipboard = subprocess.run(["xclip", "-selection", "clipboard", "-o"], env=environment, check=True, capture_output=True, text=True, timeout=5)
                assert clipboard.stdout == key, "Native clipboard must contain the isolated profile key"
                assert not invoke("get_management_key")["ok"], "Raw management keys must not cross IPC"
                print("PASS real native controls: owned proxy started, authenticated Go APIs, clipboard copied, raw-key IPC denied", flush=True)
                stopped = invoke("stop_proxy")
                assert stopped["ok"] and not stopped["value"]["running"] and not stopped["value"]["owned"], stopped
                print("PASS real native controls: owned proxy stopped", flush=True)
                restarted = invoke("start_proxy")
                assert restarted["ok"] and restarted["value"]["running"] and restarted["value"]["owned"], restarted
                assert key not in execute("return document.documentElement.outerHTML")
                wait_until(lambda: "running" in execute("return document.querySelector('#proxy-status').textContent").lower())
                Path(options.screenshot).parent.mkdir(parents=True, exist_ok=True)
                screenshot_code, screenshot = request(session_url + "/screenshot")
                assert screenshot_code == 200, screenshot
                Path(options.screenshot).write_bytes(base64.b64decode(screenshot["value"]))
                controls = request(session_url + "/window")[1]["value"]
                controls_url = request(session_url + "/url")[1]["value"]
                assert invoke("open_dashboard")["ok"]
                time.sleep(1)
                dashboard_screenshot = str(Path(options.screenshot).with_name("native-dashboard.png"))
                subprocess.run(["import", "-window", "root", dashboard_screenshot], env=environment, check=True)
                handles = request(session_url + "/window/handles")[1]["value"]
                dashboard = next((handle for handle in handles if handle != controls), None)
                if dashboard:
                    request(session_url + "/window", "POST", {"handle": dashboard})
                else:
                    print("INFO: WebKit hides the incognito dashboard from WebDriver; testing external-origin IPC denial in the automatable controls WebView.", flush=True)
                    code, navigated = request(session_url + "/url", "POST", {"url": server_url + "/subscriptions/"})
                    assert code == 200, navigated
                wait_until(lambda: execute("return !!document.querySelector('#unlock-form')"))
                denied = invoke("get_status")
                assert not denied["ok"], "Dashboard windows must not invoke native controls"
                assert not invoke("copy_management_key")["ok"], "Dashboard windows must not access the native key clipboard"
                print("External-origin IPC rejection:", denied["error"], flush=True)
                # React's controlled field needs its native setter when driven outside the UI.
                execute("const input=document.querySelector('#management-key');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,arguments[0]);input.dispatchEvent(new Event('input',{bubbles:true}));", key)
                execute("document.querySelector('#unlock-form button[type=submit]').click();")
                wait_until(lambda: execute("return !document.querySelector('#unlock-dialog')"))
                assert execute("return document.querySelector('#stat-total').textContent") == "0"
                assert execute("return localStorage.length + sessionStorage.length") == 0
                if dashboard:
                    request(session_url + "/window", "POST", {"handle": controls})
                else:
                    code, restored = request(session_url + "/url", "POST", {"url": controls_url})
                    assert code == 200, restored
                    wait_until(lambda: execute("return !!document.querySelector('#proxy-status')"))
                stopped = invoke("stop_proxy")
                assert stopped["ok"] and not stopped["value"]["running"] and not stopped["value"]["owned"], stopped
                print("PASS native WebKit: real IPC, owned sidecar start/stop, keyed Go APIs, native clipboard, dashboard hydration/unlock, denied external-origin IPC, private browser state")
                print("Screenshot:", options.screenshot)
                print("Dashboard screenshot:", dashboard_screenshot)
            except Exception:
                log.flush()
                print("Native driver diagnostics:", log_path.read_text()[-12000:])
                if driver:
                    diagnostics = subprocess.run(["ps", "-o", "pid,ppid,stat,comm", "-g", str(driver.pid)], capture_output=True, text=True)
                    print("Native test process group:", diagnostics.stdout)
                raise
            finally:
                if session:
                    try:
                        request(session_url, "DELETE")
                    except OSError:
                        pass
                stop_group(driver)
                stop_group(display)


if __name__ == "__main__":
    main()
