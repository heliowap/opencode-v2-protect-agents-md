import dataclasses
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading


REPO = Path(__file__).resolve().parents[2]
LAUNCHER = REPO / "bin" / "protect-agents.ts"
NETWORK_PROFILE = (
    '(version 1) (allow default) (deny network-outbound) '
    '(allow network-outbound (remote ip "localhost:*"))'
)
SEED = b"before\n"
DENIAL = re.compile(r"Operation not permitted|Permission denied|Read-only file system", re.I)


@dataclasses.dataclass(frozen=True)
class Case:
    name: str
    operation: str
    guarded: bool
    target: str = "AGENTS.md"
    protect_exact: bool = False


CASES = (
    Case("patch-control", "patch", False),
    Case("append-control", "append", False),
    Case("persistent-terminal-control", "terminal", False),
    Case("exact-path-control", "patch", False, "instructions.txt"),
    Case("patch-denied", "patch", True),
    Case("unrelated-patch-allowed", "patch", True, "ordinary.txt"),
    Case("protected-read-allowed", "read", True),
    Case("append-denied", "append", True),
    Case("persistent-terminal-denied", "terminal", True),
    Case("exact-path-denied", "patch", True, "instructions.txt", True),
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def binary(variable, name):
    candidate = os.environ.get(variable) or shutil.which(name)
    if not candidate:
        raise RuntimeError(f"{name} is required; set {variable} or add it to PATH")
    path = Path(candidate).expanduser().absolute()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise RuntimeError(f"{variable} is not an executable file: {path}")
    return str(path)


def run(argv, environment, cwd, timeout=45):
    process = subprocess.Popen(
        argv, env=environment, cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        raise RuntimeError(f"process timed out: {argv!r}\n{stdout[-4000:]}\n{stderr[-4000:]}")
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def function(call_id, name, arguments):
    return {"type": "function_call", "call_id": call_id, "name": name,
            "arguments": json.dumps(arguments)}


def isolated_environment(directory, codex, bun):
    home = directory / "home"
    codex_home = directory / "codex-home"
    temporary = directory / "tmp"
    executables = directory / "bin"
    for path in (home, codex_home, temporary, executables):
        path.mkdir(parents=True)
    for name, executable in (("codex", codex), ("bun", bun), ("node", shutil.which("node"))):
        if executable:
            (executables / name).symlink_to(executable)
    return {
        "HOME": str(home), "CODEX_HOME": str(codex_home), "TMPDIR": str(temporary),
        "PATH": f"{executables}:/usr/bin:/bin:/usr/sbin:/sbin",
        "NO_PROXY": "127.0.0.1,localhost", "OFFLINE_CODEX_KEY": "offline-fake-key",
        "RUST_LOG": "warn", "LANG": "en_US.UTF-8", "TERM": "xterm-256color",
    }


class Responses:
    def __init__(self, case, workspace):
        self.case = case
        self.workspace = workspace
        self.requests = []
        self.outputs = {}
        self.snapshots = []
        self.errors = []

    def respond(self, path, body):
        require(path == "/v1/responses", f"unexpected API route {path}")
        require(isinstance(body.get("input"), list), "Responses input is not a list")
        self.requests.append(body)
        self.snapshots.append({
            path.name: path.read_bytes().hex()
            for path in self.workspace.iterdir() if path.is_file()
        })
        for item in body["input"]:
            if item.get("type") in ("function_call_output", "custom_tool_call_output"):
                self.outputs[item["call_id"]] = item["output"]
        step = len(self.requests)
        limit = 3 if self.case.operation == "terminal" else 2
        require(step <= limit, "client exceeded the finite fixture conversation")
        if step == 1:
            if self.case.operation == "patch":
                item = {
                    "type": "custom_tool_call", "call_id": "edit", "name": "apply_patch",
                    "input": f"*** Begin Patch\n*** Update File: {self.case.target}\n"
                             "@@\n-before\n+after\n*** End Patch",
                }
            elif self.case.operation == "terminal":
                item = function("open", "exec_command", {
                    "cmd": "/bin/sh", "tty": True, "yield_time_ms": 1000,
                    "workdir": str(self.workspace),
                })
            else:
                command = "/bin/cat AGENTS.md" if self.case.operation == "read" else (
                    "printf 'appended\\n' >> AGENTS.md"
                )
                item = function("edit", "exec_command", {
                    "cmd": command, "yield_time_ms": 1000, "workdir": str(self.workspace),
                })
        elif self.case.operation == "terminal" and step == 2:
            require("open" in self.outputs, "missing native exec_command output")
            match = re.search(r"session ID (\d+)", json.dumps(self.outputs["open"]))
            require(match is not None, "native /bin/sh did not create a persistent session")
            item = function("edit", "write_stdin", {
                "session_id": int(match[1]), "yield_time_ms": 1000,
                "chars": "printf 'appended\\n' >> AGENTS.md\n"
                         "result=$?\n"
                         "printf 'WRITE_STATUS=%s\\n' \"$result\"\n"
                         "printf 'terminal-ok\\n' > terminal.txt\n"
                         "printf 'TERMINAL_OK\\n'\nexit\n",
            })
        else:
            require("edit" in self.outputs, "missing native tool continuation")
            item = {"type": "message", "id": "msg_finished", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Offline fixture finished."}]}
        response_id = f"resp_{step}"
        events = [
            {"type": "response.created", "response": {"id": response_id}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": response_id,
             "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
        ]
        return "".join(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n'
                       for event in events).encode()


def run_case(case, root, codex, bun):
    directory = root / case.name
    workspace = directory / "workspace"
    workspace.mkdir(parents=True)
    environment = isolated_environment(directory, codex, bun)
    codex_home = Path(environment["CODEX_HOME"])
    target = workspace / case.target
    target.write_bytes(SEED)
    protected = workspace / "AGENTS.md"
    if protected != target:
        protected.write_bytes(SEED)
    fixture = Responses(case, workspace)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def do_GET(self):
            fixture.errors.append(f"unexpected GET {self.path}")
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            try:
                length = int(self.headers["Content-Length"])
                require(0 < length <= 2_000_000, "invalid request length")
                body = json.loads(self.rfile.read(length))
                data = fixture.respond(self.path, body)
            except Exception as error:
                fixture.errors.append(f"{type(error).__name__}: {error}")
                self.send_response(500)
                self.end_headers()
                return
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (codex_home / "config.toml").write_text(f'''model = "gpt-6.1-sol"
model_provider = "offline"
web_search = "disabled"
[features]
hooks = false
unified_exec = true
[model_providers.offline]
name = "Local deterministic Responses fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
env_key = "OFFLINE_CODEX_KEY"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
''')
    arguments = ["exec", "--strict-config", "--ephemeral", "--skip-git-repo-check",
                 "--ignore-rules", "--dangerously-bypass-approvals-and-sandbox",
                 "-C", str(workspace), "--json", "Run the offline fixture."]
    command = [codex, *arguments]
    if case.guarded:
        command = [bun, str(LAUNCHER), "--client", "codex", "--binary", codex, "--offline"]
        if case.protect_exact:
            command += ["--protect", str(target.resolve())]
        command += ["--", *arguments]
    try:
        result = run(([] if case.guarded else ["/usr/bin/sandbox-exec", "-p", NETWORK_PROFILE]) + command,
                     environment, workspace)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    output = json.dumps(fixture.outputs.get("edit", ""))
    evidence = {
        "case": case.name, "returncode": result.returncode,
        "requests": len(fixture.requests), "outputs": fixture.outputs,
        "fixture_bytes": target.read_bytes().hex(), "snapshots": fixture.snapshots,
        "server_errors": fixture.errors, "stdout": result.stdout[-6000:],
        "stderr": result.stderr[-6000:],
    }
    try:
        require(not fixture.errors, f"Responses fixture failed: {fixture.errors}")
        if case.guarded and "sandbox_apply: Operation not permitted" in result.stderr:
            raise RuntimeError("macOS rejected nested sandboxes; the launcher must combine "
                               "network and protected-file rules in one profile")
        require(result.returncode == 0, "client launch or native Codex process failed")
        expected_requests = 3 if case.operation == "terminal" else 2
        require(len(fixture.requests) == expected_requests, "native tool round trip was incomplete")
        require("edit" in fixture.outputs, "native tool output was not recorded")
        denied = case.guarded and (case.target == "AGENTS.md" or case.protect_exact)
        if case.operation == "read":
            require("before\\n" in output, "native cat did not return protected seed")
            require(target.read_bytes() == SEED, "read changed protected bytes")
            require("Process exited with code 0" in output, "native cat failed")
        elif denied:
            require(target.read_bytes() == SEED, "protected bytes changed")
            if case.operation == "patch":
                require(DENIAL.search(output) or "Failed to write file" in output,
                        "native apply_patch did not report a write failure")
            else:
                require(DENIAL.search(output), "shell did not report an OS write denial")
        else:
            expected = b"after\n" if case.operation == "patch" else b"before\nappended\n"
            require(target.read_bytes() == expected, "allowed native write did not succeed")
            require(not DENIAL.search(output), "allowed native tool reported a denial")
        if case.operation == "append":
            status = 1 if denied else 0
            require(f"Process exited with code {status}" in output, "wrong shell write exit status")
        if case.operation == "terminal":
            status = 1 if denied else 0
            require(f"WRITE_STATUS={status}" in output, "persistent write status was not observed")
            require((workspace / "terminal.txt").read_bytes() == b"terminal-ok\n",
                    "persistent shell broke instead of continuing after the write")
            require("Process exited with code 0" in output, "persistent shell failed to exit normally")
        if target != protected:
            require(protected.read_bytes() == SEED, "unrelated operation changed AGENTS.md")
    except Exception:
        print(json.dumps(evidence, indent=2), file=sys.stderr)
        raise
    return {"case": case.name, "requests": len(fixture.requests), "guarded": case.guarded}


def main():
    if sys.platform != "darwin":
        raise RuntimeError("Codex launcher E2E requires macOS sandbox-exec")
    codex = binary("CODEX_BIN", "codex")
    bun = binary("BUN_BIN", "bun")
    if not LAUNCHER.is_file():
        raise RuntimeError(f"launcher is not ready: {LAUNCHER}; rerun after it is built")
    temporary = Path(tempfile.gettempdir()).resolve()
    if (temporary / "opencode").is_dir():
        temporary /= "opencode"
    with tempfile.TemporaryDirectory(prefix="codex-launcher-e2e-", dir=temporary) as directory:
        root = Path(directory)
        environment = isolated_environment(root / "metadata", codex, bun)
        version = run([codex, "--version"], environment, root, timeout=10)
        help_result = run([codex, "exec", "--help"], environment, root, timeout=10)
        require(version.returncode == help_result.returncode == 0, "Codex version/help failed")
        for option in ("--strict-config", "--ephemeral", "--skip-git-repo-check", "--ignore-rules",
                       "--dangerously-bypass-approvals-and-sandbox", "--json", "--cd"):
            require(option in help_result.stdout, f"installed Codex does not support {option}")
        network_check = run([
            "/usr/bin/sandbox-exec", "-p", NETWORK_PROFILE, sys.executable, "-c",
            "import socket\ns=socket.socket()\ns.settimeout(1)\n"
            "try: s.connect(('192.0.2.1',443))\n"
            "except PermissionError: print('OUTBOUND_DENIED')\n"
            "else: raise AssertionError('outbound network permitted')\n",
        ], environment, root, timeout=10)
        require(network_check.returncode == 0 and network_check.stdout == "OUTBOUND_DENIED\n",
                f"outer sandbox did not deny non-loopback traffic: {network_check}")
        results = []
        for case in CASES:
            results.append(run_case(case, root, codex, bun))
            print(json.dumps({"passed": case.name}), file=sys.stderr)
    print(json.dumps({"client": "codex", "version": version.stdout.strip(),
                      "cases": len(results), "guarded": sum(case.guarded for case in CASES),
                      "controls": sum(not case.guarded for case in CASES),
                      "cloud_requests": 0, "network": "OS-enforced loopback only"}))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, RuntimeError, OSError) as error:
        print(f"Codex E2E failed: {error}", file=sys.stderr)
        sys.exit(1)
