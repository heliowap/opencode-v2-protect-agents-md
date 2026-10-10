import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "process-guard-cli-"))
const entry = join(import.meta.dir, "../bin/protect-agents.ts")
const env = { ...process.env, HOME: root, ZDOTDIR: root }
const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], {
  cwd: root, env, stdout: "pipe", stderr: "pipe",
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => writeFileSync(join(root, "notes.md"), "ordinary"))

test("help describes the actual scope without launching a client", () => {
  const result = invoke("--help")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("Cursor Agent CLI")
  expect(result.stdout.toString()).toContain("no in-session unlock")
})

test.each(["constructor", "__proto__", "cursor-ide", "unknown"])("unsupported client %s fails closed", (client) => {
  const result = invoke("--client", client, "--binary", "/bin/sh", "--", "-c", "touch unexpected")
  expect(result.exitCode).not.toBe(0)
  expect(existsSync(join(root, "unexpected"))).toBe(false)
})

describe.skipIf(process.platform !== "darwin")("macOS process-tree enforcement", () => {
  test.each(["cursor", "codex", "claude"])("%s profile allows reads and unrelated writes but denies protected append", (client) => {
    const target = join(root, "AGENTS.md")
    writeFileSync(target, "original\n")
    const read = invoke("--client", client, "--binary", "/bin/cat", "--", target)
    expect(read.exitCode).toBe(0)
    expect(read.stdout.toString()).toBe("original\n")
    const write = invoke("--client", client, "--binary", "/bin/sh", "--", "-c", "printf ordinary > notes.md")
    expect(write.exitCode).toBe(0)
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("ordinary")
    const append = invoke("--client", client, "--binary", "/bin/sh", "--", "-c", "printf changed >> AGENTS.md")
    expect(append.exitCode).not.toBe(0)
    expect(append.stderr.toString()).toContain("Operation not permitted")
    expect(readFileSync(target, "utf8")).toBe("original\n")
  })

  test.each(["AGENTS.md", "agents.MD", "AgEnTs.Md"])("protects the exact case-insensitive basename %s", (name) => {
    const target = join(root, "case", name)
    mkdirSync(join(root, "case"), { recursive: true })
    writeFileSync(target, "original")
    const result = invoke("--client", "codex", "--binary", "/bin/cp", "--", join(root, "notes.md"), target)
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("original")
  })

  test.each(["AGENTSXmd", "AGENTS.md.backup", "myAGENTS.md"])("does not deny the ordinary basename %s", (name) => {
    const target = join(root, name)
    const result = invoke("--client", "claude", "--binary", "/bin/cp", "--", join(root, "notes.md"), target)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(target, "utf8")).toBe("ordinary")
  })

  test("denies creation of a new protected file", () => {
    mkdirSync(join(root, "new"))
    const target = join(root, "new", "AGENTS.md")
    const result = invoke("--client", "cursor", "--binary", "/bin/cp", "--", join(root, "notes.md"), target)
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  test("denies deletion and both directions of a rename", () => {
    const target = join(root, "AGENTS.md")
    writeFileSync(target, "original")
    const deletion = invoke("--client", "codex", "--binary", "/bin/rm", "--", target)
    expect(deletion.exitCode).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("original")
    const moveAway = invoke("--client", "codex", "--binary", "/bin/mv", "--", target, join(root, "renamed.md"))
    expect(moveAway.exitCode).not.toBe(0)
    expect(existsSync(join(root, "renamed.md"))).toBe(false)
    const overwrite = invoke("--client", "codex", "--binary", "/bin/mv", "--", join(root, "notes.md"), target)
    expect(overwrite.exitCode).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("original")
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("ordinary")
  })

  test("denies writes through a symlink to the protected file", () => {
    const target = join(root, "AGENTS.md")
    const alias = join(root, "instruction-link")
    writeFileSync(target, "original")
    symlinkSync(target, alias)
    const result = invoke("--client", "claude", "--binary", "/bin/cp", "--", join(root, "notes.md"), alias)
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("original")
  })

  test("canonicalizes the workspace's protected symlink to an ordinary target", () => {
    const target = join(root, "AGENTS.md")
    const physical = join(root, "instruction-source.txt")
    rmSync(target)
    writeFileSync(physical, "original")
    symlinkSync(physical, target)
    const result = invoke("--client", "cursor", "--binary", "/bin/cp", "--", join(root, "notes.md"), physical)
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(physical, "utf8")).toBe("original")
    rmSync(target)
    writeFileSync(target, "original")
  })

  test("rejects a dangling protected symlink before starting the client", () => {
    const target = join(root, "AGENTS.md")
    const physical = join(root, "future.txt")
    rmSync(target)
    symlinkSync(physical, target)
    const result = invoke("--client", "claude", "--binary", "/usr/bin/touch", "--", physical)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("unresolved symbolic link")
    expect(existsSync(physical)).toBe(false)
    rmSync(target)
    writeFileSync(target, "original")
  })

  test("a persistent child shell cannot write through stdin", () => {
    const target = join(root, "AGENTS.md")
    writeFileSync(target, "original")
    const result = Bun.spawnSync([process.execPath, entry, "--client", "codex", "--binary", "/bin/sh", "--", "-c", "/bin/sh"], {
      cwd: root, env, stdin: Buffer.from("printf changed > AGENTS.md\n"), stdout: "pipe", stderr: "pipe",
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Operation not permitted")
    expect(readFileSync(target, "utf8")).toBe("original")
  })

  test("additional physical targets with profile punctuation are protected without injection", () => {
    const name = 'ordinary " ) (allow file-write*) \\ name.md'
    const target = join(root, name)
    writeFileSync(target, "original")
    const result = invoke("--client", "codex", "--binary", "/bin/cp", "--protect", target, "--", join(root, "notes.md"), target)
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("original")
  })

  test("locks ancestors of explicit physical targets against relocation", () => {
    const directory = join(root, "anchored")
    const moved = join(root, "moved")
    mkdirSync(directory)
    const target = join(directory, "instructions.txt")
    writeFileSync(target, "original")
    const result = invoke("--client", "claude", "--binary", "/bin/mv", "--protect", target, "--", directory, moved)
    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(target, "utf8")).toBe("original")
    expect(existsSync(moved)).toBe(false)
  })

  test("refuses a selected file with existing hardlinks before client startup", () => {
    const target = join(root, "hardlinked.txt")
    const alias = join(root, "hardlink-alias.txt")
    writeFileSync(target, "original")
    linkSync(target, alias)
    const result = invoke("--client", "codex", "--binary", "/usr/bin/touch", "--protect", target, "--", join(root, "unexpected"))
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("existing hardlinks")
    expect(existsSync(join(root, "unexpected"))).toBe(false)
    expect(readFileSync(alias, "utf8")).toBe("original")
  })

  test("rejects missing explicit parents before a child can introduce a symlink", () => {
    const other = join(root, "other")
    mkdirSync(other)
    writeFileSync(join(other, "policy.txt"), "original")
    const future = join(root, "future")
    const result = invoke("--client", "codex", "--binary", "/bin/sh", "--protect", join(future, "policy.txt"), "--", "-c", "ln -s other future && printf changed > future/policy.txt")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("existing parent directory")
    expect(existsSync(future)).toBe(false)
    expect(readFileSync(join(other, "policy.txt"), "utf8")).toBe("original")
  })

  test.each(["stdout", "stderr"] as const)("refuses a protected inherited %s without writing diagnostics into it", (stream) => {
    const target = join(root, "AGENTS.md")
    writeFileSync(target, "original")
    const fd = openSync(target, "a")
    try {
      const result = Bun.spawnSync([process.execPath, entry, "--client", "codex", "--binary", "/usr/bin/touch", "--", join(root, "unexpected")], {
        cwd: root, env, stdout: stream === "stdout" ? fd : "pipe", stderr: stream === "stderr" ? fd : "pipe",
      })
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(join(root, "unexpected"))).toBe(false)
      expect(readFileSync(target, "utf8")).toBe("original")
    } finally {
      closeSync(fd)
    }
  })

  test.each<[string[]]>([
    [["--bad-option"]],
    [["--client", "unknown"]],
    [["--client", "codex", "--binary", "missing-client"]],
  ])("argument failure %j cannot write diagnostics into a protected stderr", (args) => {
    const target = join(root, "AGENTS.md")
    writeFileSync(target, "original")
    const fd = openSync(target, "a")
    try {
      const result = Bun.spawnSync([process.execPath, entry, ...args], {
        cwd: root, env, stdout: "pipe", stderr: fd,
      })
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(target, "utf8")).toBe("original")
    } finally {
      closeSync(fd)
    }
  })

  test.each<[string[]]>([
    [["--help"]],
    [["--bad-option"]],
    [["--client", "codex", "--binary", "missing-client"]],
  ])("explicit protected streams are safe before validating %j", (args) => {
    const target = join(root, "startup-policy.txt")
    writeFileSync(target, "original")
    const fd = openSync(target, "a")
    try {
      const result = Bun.spawnSync([process.execPath, entry, "--protect", target, ...args], {
        cwd: root, env, stdout: fd, stderr: fd,
      })
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(target, "utf8")).toBe("original")
    } finally {
      closeSync(fd)
    }
  })

  test.each(["invalid earlier path", "missing earlier option value"])("stream discovery preserves bytes with %s", (scenario) => {
    const target = join(root, "discovery-policy.txt")
    writeFileSync(target, "original")
    const args = scenario === "invalid earlier path"
      ? ["--protect", join(root, "notes.md", "child"), "--protect", target, "--client", "codex", "--binary", "/usr/bin/touch", "--", join(root, "unexpected")]
      : ["--protect", `--protect=${target}`, "--bad-option"]
    const fd = openSync(target, "a")
    try {
      const result = Bun.spawnSync([process.execPath, entry, ...args], {
        cwd: root, env, stdout: "pipe", stderr: fd,
      })
      expect(result.exitCode).not.toBe(0)
      expect(readFileSync(target, "utf8")).toBe("original")
      expect(existsSync(join(root, "unexpected"))).toBe(false)
    } finally {
      closeSync(fd)
    }
  })

  test("offline mode denies nonloopback connections at the OS boundary", () => {
    const script = "import socket\ns=socket.socket()\ns.settimeout(1)\ntry: s.connect(('192.0.2.1',443))\nexcept PermissionError: print('OUTBOUND_DENIED')\nelse: raise AssertionError('outbound network permitted')\n"
    const result = invoke("--client", "cursor", "--binary", "/usr/bin/python3", "--offline", "--", "-c", script)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("OUTBOUND_DENIED\n")
  })

  test("the client's nonzero exit status is preserved", () => {
    expect(invoke("--client", "claude", "--binary", "/bin/sh", "--", "-c", "exit 23").exitCode).toBe(23)
  })

  test("missing executables do not launch an unrestricted fallback", () => {
    const result = invoke("--client", "cursor", "--binary", join(root, "missing-client"))
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("executable not found")
  })
})
