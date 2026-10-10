import http.server
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.parse


REPO = Path(__file__).resolve().parents[2]
TEMP_PARENT = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "opencode"
ORIGINAL = "owned-fixture-original\n"
REPLACEMENT = "owned-fixture-replaced\n"
FAKE_KEY = "offline-test-key-not-a-real-credential"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def binary(name, override):
    found = shutil.which(os.environ.get(override, name))
    require(found is not None, f"Install {name} or set {override} to its executable")
    return Path(found).resolve()


def run(command, environment, cwd, timeout=60):
    process = subprocess.Popen(
        command, env=environment, cwd=cwd, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        raise RuntimeError(f"Client timed out after {timeout}s. {stderr[-1000:]} {stdout[-1000:]}")
    return process.returncode, stdout, stderr


class Endpoint(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            self.server.calls.append((dict(self.headers), body))
            path = urllib.parse.urlsplit(self.path).path
            if path == "/v1/messages/count_tokens":
                self.reply(json.dumps({"input_tokens": 100}).encode(), "application/json")
                return
            if path != "/v1/messages":
                self.server.errors.append(f"Unexpected endpoint {path}")
                self.send_error(404)
                return
            results = {
                part["tool_use_id"]: part
                for message in body.get("messages", [])
                if isinstance(message.get("content"), list)
                for part in message["content"]
                if part.get("type") == "tool_result"
            }
            self.server.results.update(results)
            main = any(tool.get("name") == "Write" for tool in body.get("tools", []))
            block = next(
                (step for step in self.server.steps if step["id"] not in results),
                {"type": "text", "text": "Offline fixture complete"},
            ) if main else {"type": "text", "text": "Offline auxiliary response"}
            tool = block["type"] == "tool_use"
            message = {
                "id": "msg_offline_" + str(len(self.server.calls)),
                "type": "message", "role": "assistant", "model": body["model"],
                "content": [block], "stop_reason": "tool_use" if tool else "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 100, "output_tokens": 10,
                          "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            }
            if not body.get("stream"):
                self.reply(json.dumps(message).encode(), "application/json")
                return
            events = [
                {"type": "message_start", "message": dict(message, content=[], stop_reason=None)},
                {"type": "content_block_start", "index": 0,
                 "content_block": dict(block, input={}) if tool else dict(block, text="")},
                {"type": "content_block_delta", "index": 0,
                 "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
                 if tool else {"type": "text_delta", "text": block["text"]}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": message["stop_reason"],
                 "stop_sequence": None}, "usage": {"output_tokens": 10}},
                {"type": "message_stop"},
            ]
            data = "".join(
                "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                for event in events
            ).encode()
            self.reply(data, "text/event-stream")
        except Exception as error:
            self.server.errors.append(str(error))
            self.send_error(500)

    def reply(self, data, content_type):
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def scenario(claude, bun, guarded):
    with tempfile.TemporaryDirectory(prefix="claude-e2e-", dir=TEMP_PARENT) as directory:
        root = Path(directory).resolve()
        home, work, tmp = (root / name for name in ("home", "work", "tmp"))
        for path in (home, work, tmp):
            path.mkdir()
        target, notes, alias = (work / name for name in ("AGENTS.md", "notes.md", "policy.txt"))
        target.write_text(ORIGINAL)
        alias.write_text(ORIGINAL)
        steps = [
            ("read_before", "Read", {"file_path": str(target)}),
            ("write", "Write", {"file_path": str(target), "content": REPLACEMENT}),
            ("read_after", "Read", {"file_path": str(target)}),
            ("notes", "Write", {"file_path": str(notes), "content": "ordinary-write\n"}),
            ("bash", "Bash", {"command": "printf shell-append >> " + shlex.quote(str(target)),
                              "description": "Append to owned disposable fixture"}),
            ("alias_read", "Read", {"file_path": str(alias)}),
            ("alias_write", "Write", {"file_path": str(alias), "content": REPLACEMENT}),
        ]
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
        server.calls, server.results, server.errors = [], {}, []
        server.steps = [
            {"type": "tool_use", "id": "toolu_" + name, "name": tool, "input": arguments}
            for name, tool, arguments in steps
        ]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            environment = {
                "HOME": str(home), "CLAUDE_CONFIG_DIR": str(home / ".claude"),
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
                "TMPDIR": str(tmp), "CLAUDE_CODE_TMPDIR": str(tmp),
                "SHELL": "/bin/sh", "LANG": "en_US.UTF-8", "TERM": "dumb",
                "ANTHROPIC_API_KEY": FAKE_KEY,
                "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
                "CLAUDE_CODE_AUTO_CONNECT_IDE": "false", "API_TIMEOUT_MS": "10000",
            }
            profile = root / "isolation.sb"
            profile.write_text(f'''(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:{server.server_port}"))
(deny file-write*)
(allow file-write* (subpath {json.dumps(str(root))}) (literal "/dev/null"))
(deny file-read* (subpath {json.dumps(str(Path.home()))}) (subpath "/Library/Keychains") (subpath "/Library/Application Support/ClaudeCode"))
(allow file-read* (literal {json.dumps(str(claude))}) (literal {json.dumps(str(bun))}) (literal {json.dumps(str(Path(sys.executable).resolve()))}) (subpath {json.dumps(str(REPO))}) (subpath {json.dumps(str(root))}))
(deny process-exec (literal "/usr/bin/security"))
''')
            isolated = ["/usr/bin/sandbox-exec", "-f", str(profile)]
            code, _, error = run(isolated + [sys.executable, "-c",
                "import socket; s=socket.socket(); s.settimeout(1); s.connect(('192.0.2.1',443))"],
                environment, work, timeout=10)
            require(code != 0 and "Operation not permitted" in error,
                    "Outer sandbox failed to deny nonloopback egress")
            code, version, error = run(isolated + [str(claude), "--version"], environment, work, 10)
            require(code == 0, f"Claude version failed. {error[-1000:]}")
            code, help_text, error = run(isolated + [str(claude), "--help"], environment, work, 10)
            require(code == 0, f"Claude help failed. {error[-1000:]}")
            settings = root / "settings.json"
            settings.write_text(json.dumps({"disableAllHooks": True}))
            arguments = [
                "--print", "--settings", str(settings), "--setting-sources", "",
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--no-chrome", "--disable-slash-commands", "--no-session-persistence",
                "--dangerously-skip-permissions", "--tools", "Write,Bash,Read",
                "--model", "claude-sonnet-4-6", "--output-format", "stream-json", "--verbose",
            ]
            require("--setting-sources" in help_text and "--dangerously-skip-permissions" in help_text,
                    "Installed Claude does not support the required isolated CLI flags")
            arguments.append("Execute the owned offline fixture tools supplied by the model stub.")
            command = [str(claude)]
            if guarded:
                require((REPO / "bin/protect-agents.ts").is_file(),
                        "Launcher is not available yet. Control passed; rerun when bin/protect-agents.ts exists")
                command = [str(bun), str(REPO / "bin/protect-agents.ts"),
                           "--client", "claude", "--binary", str(claude), "--protect", str(alias), "--offline", "--"]
            code, stdout, stderr = run(([] if guarded else isolated) + command + arguments, environment, work)
            require(not (guarded and "sandbox_apply: Operation not permitted" in stderr),
                    "Launcher protection cannot be applied inside the outer isolation sandbox. "
                    f"Guarded E2E is unverified, exit={code}. {stderr.strip()}")
            require(code == 0, f"Client exited {code}. {stderr[-1200:]} {stdout[-1200:]}")
            require(not server.errors, f"Offline stub failed. {server.errors}")
            require(server.calls, "Client never reached offline model stub")
            require(all(
                next((value for key, value in headers.items() if key.lower() == "x-api-key"), None) == FAKE_KEY
                and not any(key.lower() == "authorization" for key in headers)
                for headers, _ in server.calls
            ), "Client did not use only the fake fixture API key")
            events = [json.loads(line) for line in stdout.splitlines() if line.startswith("{")]
            final = next((event for event in reversed(events) if event.get("type") == "result"), {})
            require(final.get("subtype") == "success" and not final.get("is_error"),
                    f"Native client did not finish successfully. {json.dumps(final)[-1200:]}")
            results = server.results
            require(set(results) == {step["id"] for step in server.steps},
                    f"Missing native tool results. Received {sorted(results)}. "
                    f"Offered tools {[tool.get('name') for _, body in server.calls for tool in body.get('tools', [])]}. "
                    f"{json.dumps(final)[-1000:]} {stderr[-1000:]}")
            for name in ("read_before", "alias_read"):
                result = results["toolu_" + name]
                require(not result.get("is_error") and "owned-fixture-original" in json.dumps(result),
                        f"Native {name} did not read original. {result}")
            after = results["toolu_read_after"]
            expected_read = "owned-fixture-original" if guarded else "owned-fixture-replaced"
            cached_unchanged = guarded and "file unchanged since your last Read." in json.dumps(after)
            require(not after.get("is_error") and (expected_read in json.dumps(after) or cached_unchanged),
                    f"Native read after Write was incorrect. {after}")
            require(not results["toolu_notes"].get("is_error") and notes.read_text() == "ordinary-write\n",
                    f"Unrelated native Write failed. {results['toolu_notes']}")
            for name in ("write", "bash", "alias_write"):
                result = results["toolu_" + name]
                if guarded:
                    require(result.get("is_error") is True and re.search(
                        r"operation not permitted|permission denied|EPERM|EACCES", json.dumps(result), re.I),
                        f"Native {name} did not report an OS permission denial. {result}")
                    require("hook error" not in json.dumps(result).lower(), f"Hook denied {name} instead of OS")
                else:
                    require(not result.get("is_error"), f"Unguarded native {name} failed. {result}")
            require(target.read_text() == (ORIGINAL if guarded else REPLACEMENT + "shell-append"),
                    "Protected target contents differ from expected native effects")
            require(alias.read_text() == (ORIGINAL if guarded else REPLACEMENT),
                    "Explicit protected alias contents differ from expected native effects")
            mode = "guarded" if guarded else "control"
            print(f"PASS {mode}, Claude {version.strip()}, disableAllHooks=true, 7 native tool results")
            return version.strip()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def main():
    require(sys.platform == "darwin", "This opt-in native client test requires macOS sandbox-exec")
    require(Path("/usr/bin/sandbox-exec").is_file(), "macOS sandbox-exec is unavailable")
    require(TEMP_PARENT.is_dir(), f"Approved temporary parent does not exist. {TEMP_PARENT}")
    claude, bun = binary("claude", "CLAUDE_BIN"), binary("bun", "BUN_BIN")
    control = scenario(claude, bun, guarded=False)
    guarded = scenario(claude, bun, guarded=True)
    require(control == guarded, "Claude version changed between control and guarded runs")
    print("PASS real Claude Code E2E with loopback-only transport and disposable homes")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
