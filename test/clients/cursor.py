import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time


REPO = Path(__file__).resolve().parents[2]
PROFILE = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
SEED = b"native-seed\n"
CASES = {
    "Write": (3, 3, None, b"native-write\n", {3, 5}),
    "Delete": (4, 4, SEED, None, {4, 7}),
    "PiWrite": (48, 49, SEED, b"native-piwrite\n", {2}),
    "PiEdit": (47, 48, SEED, b"native-piedit\n", {2}),
    "Read": (7, 7, SEED, SEED, set()),
}


def varint(value):
    data = bytearray()
    while value > 127:
        data.append((value & 127) | 128)
        value >>= 7
    return bytes(data) + bytes([value])


def field(number, data):
    data = data.encode() if isinstance(data, str) else data
    return varint(number * 8 + 2) + varint(len(data)) + data


def decode(data):
    result, offset = {}, 0

    def integer():
        nonlocal offset
        value, shift = 0, 0
        while shift < 70:
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7
        raise ValueError("Invalid protobuf varint")

    while offset < len(data):
        tag = integer()
        wire = tag & 7
        if wire == 0:
            value = integer()
        else:
            size = integer() if wire == 2 else {1: 8, 5: 4}[wire]
            value = data[offset:offset + size]
            if len(value) != size:
                raise ValueError("Truncated protobuf field")
            offset += size
        result[tag >> 3] = value
    return result


def stop(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return process.communicate(timeout=5)


def run_case(root, binary, bun, operation, guarded, unrelated=False):
    request_field, reply_field, seed, expected, denied_variants = CASES[operation]
    label = f"{operation}-{'guarded' if guarded else 'control'}{'-notes' if unrelated else ''}"
    directory = root / label
    home, workspace = directory / "home", directory / "workspace"
    for path in (home / ".cursor", workspace, directory / "tmp", directory / "cache"):
        path.mkdir(parents=True)
    (home / ".cursor/cli-config.json").write_text(json.dumps({"version": 1, "network": {"useHttp1ForAgent": True}}))
    target = workspace / ("notes.txt" if unrelated else "AGENTS.md")
    if seed is not None:
        target.write_bytes(seed)
    arguments = {
        "Write": field(1, str(target)) + field(2, b"native-write\n") + field(3, "native-write"),
        "Delete": field(1, str(target)) + field(2, "native-delete"),
        "PiWrite": field(1, str(target)) + field(2, b"native-piwrite\n"),
        "PiEdit": field(1, str(target)) + field(2, field(1, "native-seed") + field(2, "native-piedit")),
        "Read": field(1, str(target)) + field(2, "native-read"),
    }[operation]
    execution = b"\x08\x01" + field(15, "native-test") + field(request_field, arguments)
    message = field(2, execution)
    replies, errors, paths = [], [], set()
    received = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                if self.headers.get("Transfer-Encoding") == "chunked":
                    chunks = []
                    while True:
                        size = int(self.rfile.readline().strip(), 16)
                        if not size:
                            self.rfile.readline()
                            break
                        chunks.append(self.rfile.read(size))
                        self.rfile.read(2)
                    body = b"".join(chunks)
                else:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                paths.add(self.path)
                if self.path.endswith("/BidiAppend"):
                    append = decode(body)
                    raw = append.get(4) or bytes.fromhex(append.get(1, b"").decode())
                    client = decode(raw)
                    if 2 in client:
                        reply = decode(client[2])
                        if reply.get(1) == 1 and reply_field in reply:
                            replies.append(decode(reply[reply_field]))
                            received.set()
                streaming = self.path.endswith("/RunSSE")
                self.send_response(200)
                self.send_header("Content-Type", "application/connect+proto" if streaming else "application/proto")
                self.end_headers()
                response = b""
                model = field(1, "probe-model") + field(3, "probe-model") + field(4, "Probe model")
                if self.path.endswith(("/GetUsableModels", "/GetDefaultModelForCli")):
                    response = field(1, model)
                elif self.path.endswith("/AvailableModels"):
                    response = field(1, "probe-model")
                elif streaming:
                    self.wfile.write(b"\x00" + len(message).to_bytes(4, "big") + message)
                    self.wfile.flush()
                    time.sleep(2)
                    response = b"\x02\x00\x00\x00\x02{}"
                self.wfile.write(response)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                errors.append(repr(error))
                received.set()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "TMPDIR": str(directory / "tmp"),
        "NODE_COMPILE_CACHE": str(directory / "cache"), "XDG_CACHE_HOME": str(directory / "cache"),
        "AGENT_CLI_CREDENTIAL_STORE": "file", "CURSOR_AGENT_CLI_AUTHLESS_MODE": "true",
        "CURSOR_API_ENDPOINT": endpoint, "CURSOR_AUTH_TOKEN": "disposable-test-key", "CI": "1", "TERM": "dumb",
    }
    command = [binary, "--endpoint", endpoint, "--agent-endpoint", endpoint, "--repo-endpoint", endpoint,
               "--print", "--output-format", "stream-json", "--trust", "--force", "--workspace", str(workspace),
               "--model", "probe-model", f"Use the native {operation} tool on {target}. Do not run shell commands."]
    if guarded:
        command = [bun, str(REPO / "bin/protect-agents.ts"), "--client", "cursor", "--binary", binary, "--offline", "--", *command[1:]]
    process = subprocess.Popen(([] if guarded else ["/usr/bin/sandbox-exec", "-p", PROFILE]) + command, cwd=workspace, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        received.wait(12)
    finally:
        stdout, stderr = stop(process)
        server.shutdown()
        server.server_close()
    diagnostic = f"{label}: replies={replies!r}, errors={errors!r}, paths={sorted(paths)!r}, stdout={stdout[-1500:]!r}, stderr={stderr[-1500:]!r}"
    assert not errors and replies, diagnostic
    denied = guarded and not unrelated and operation != "Read"
    variants = {next(iter(reply)) for reply in replies}
    assert variants <= (denied_variants if denied else {1}), diagnostic
    if denied and variants & {2, 5, 7}:
        assert all(b"EPERM" in repr(reply).encode() or b"EACCES" in repr(reply).encode() or
                   b"Operation not permitted" in repr(reply).encode() or b"Permission denied" in repr(reply).encode()
                   for reply in replies), diagnostic
    if operation == "Read":
        assert all(decode(reply[1]).get(2) == SEED for reply in replies), diagnostic
    actual = target.read_bytes() if target.exists() else None
    assert actual == (seed if denied else expected), diagnostic + f", file={actual!r}"
    print(f"PASS {label} tool-reply={','.join(map(str, sorted(variants)))} file={actual!r}", flush=True)


def main():
    if sys.platform != "darwin":
        raise SystemExit("Cursor process-guard E2E requires macOS")
    binary = os.environ.get("CURSOR_AGENT_BIN") or shutil.which("cursor-agent")
    bun = os.environ.get("BUN_BIN") or shutil.which("bun")
    if not binary or not bun:
        raise SystemExit("Set CURSOR_AGENT_BIN and BUN_BIN or install both binaries on PATH")
    binary, bun = str(Path(binary).resolve()), str(Path(bun).resolve())
    with tempfile.TemporaryDirectory(prefix="cursor-guard-e2e-", dir=os.environ.get("TMPDIR")) as temporary:
        root = Path(temporary).resolve()
        process = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", PROFILE, binary, "--version"],
                                   env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(root), "TMPDIR": str(root),
                                        "CURSOR_AGENT_CLI_AUTHLESS_MODE": "true", "AGENT_CLI_CREDENTIAL_STORE": "file"},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            version, error = process.communicate(timeout=10)
            assert process.returncode == 0, error.decode(errors="replace")
        finally:
            stop(process)
        print(f"Cursor Agent CLI {version.decode().strip()}; outbound network restricted to loopback; --force enabled", flush=True)
        for operation in ("Write", "Delete", "PiWrite", "PiEdit"):
            run_case(root, binary, bun, operation, False)
            run_case(root, binary, bun, operation, True)
        run_case(root, binary, bun, "Read", True)
        run_case(root, binary, bun, "PiWrite", True, unrelated=True)


if __name__ == "__main__":
    main()
