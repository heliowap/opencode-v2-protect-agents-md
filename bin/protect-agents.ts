#!/usr/bin/env bun
import { fstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { CLIENTS, sandboxArguments, type Client } from "../src/process-guard.ts"

const HELP = `Usage: bun run guard --client cursor|codex|claude [--binary PATH] [--protect PATH] [--offline] -- [client arguments]

Launch a local CLI on macOS with AGENTS.md writes denied for its process tree.
Reads and unrelated writes remain available. There is no in-session unlock.
--protect can be repeated to protect additional physical targets or aliases.
--offline allows outbound networking only to loopback addresses for local fixtures.
Cursor means Cursor Agent CLI, not an already running IDE.
`

class ProtectedStreamError extends Error {}

function assertSafeStreams(targets: readonly string[]): void {
  let streams
  try {
    streams = [0, 1, 2].map((fd) => fstatSync(fd))
  } catch {
    throw new ProtectedStreamError("Cannot establish standard-stream safety. No client was launched.")
  }
  for (const target of targets) {
    try {
      const file = statSync(target)
      if (streams.some((stream) => stream.isFile() && stream.dev === file.dev && stream.ino === file.ino)) {
        throw new ProtectedStreamError("A standard stream refers to a protected file. No client was launched.")
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw new ProtectedStreamError("Cannot establish standard-stream safety. No client was launched.")
      }
    }
  }
}

async function main(): Promise<number> {
  const defaults = [
    join(process.cwd(), "AGENTS.md"),
    join(homedir(), "AGENTS.md"),
    join(homedir(), ".config", "opencode", "AGENTS.md"),
    join(homedir(), ".codex", "AGENTS.md"),
  ]
  const args = process.argv.slice(2)
  const separator = args.indexOf("--")
  const options = args.slice(0, separator === -1 ? args.length : separator)
  const requested: string[] = []
  for (let index = 0; index < options.length; index++) {
    const option = options[index]
    if (option === "--protect") {
      const path = options[index + 1]
      if (path !== undefined) requested.push(path)
    } else if (option?.startsWith("--protect=")) {
      requested.push(option.slice("--protect=".length))
    }
  }
  assertSafeStreams([...defaults, ...requested])
  const { values, positionals } = parseArgs({
    args,
    options: {
      client: { type: "string" },
      binary: { type: "string" },
      protect: { type: "string", multiple: true },
      offline: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  })
  assertSafeStreams([...defaults, ...(values.protect ?? [])])
  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (!values.client || !Object.hasOwn(CLIENTS, values.client)) {
    throw new Error("Choose --client cursor, codex, or claude.")
  }
  if (process.platform !== "darwin") {
    throw new Error("This process guard requires macOS. No client was launched.")
  }
  const client = values.client as Client
  const binary = Bun.which(values.binary ?? CLIENTS[client])
  if (!binary) throw new Error(`Client executable not found: ${values.binary ?? CLIENTS[client]}`)
  const targets = defaults.filter((path) => {
    try {
      realpathSync(dirname(path))
      return true
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      return false
    }
  })
  targets.push(...(values.protect ?? []))
  const sandbox = sandboxArguments(targets, { loopbackOnly: values.offline })
  const probe = mkdtempSync(join(tmpdir(), "agents-process-check-"))
  try {
    const file = join(probe, "AGENTS.md")
    writeFileSync(file, "original")
    const check = Bun.spawnSync([...sandbox, "/bin/cp", "/dev/null", file], {
      env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe",
    })
    if (check.exitCode === 0 || !check.stderr.toString().includes("Operation not permitted") || readFileSync(file, "utf8") !== "original") {
      throw new Error("The macOS write-denial self-check failed. No client was launched.")
    }
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
  const child = Bun.spawn([...sandbox, binary, ...positionals], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    return await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    if (!(error instanceof ProtectedStreamError)) {
      console.error(error instanceof Error ? error.message : "Process guard failed. No unrestricted fallback was launched.")
    }
    process.exitCode = 1
  },
)
