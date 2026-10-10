import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { text, type Call, type ChatMessage, type Reply } from "./harness/fixture.ts"
import { Host } from "./harness/host.ts"

const ORIGINAL = "# Global rules\n"
const QUESTION = "Do you want to proceed with editing AGENTS.md?"
const DENIED = "AGENTS.md files are protected"
type Step = { tool: string; args: Record<string, unknown> }
type Plan = (dir: string) => Step[][]

let host: Host
let plan: Plan = () => []

const phaseAndStep = (messages: readonly ChatMessage[]) => {
  const lastUser = messages.findLastIndex((m) => m.role === "user" && /^prompt \d+$/.test(text(m)))
  const phase = lastUser < 0 ? -1 : Number(text(messages[lastUser]!).slice("prompt ".length))
  const rounds = messages.slice(lastUser).filter((m) => m.role === "assistant" && m.tool_calls?.length).length
  return { phase, step: rounds }
}

beforeAll(async () => {
  host = await Host.start({
    script: (call: Call): Reply => {
      const { phase, step } = phaseAndStep(call.request.messages)
      const next = plan(host.configDir)[phase]?.[step]
      return next ? { tool: next.tool, args: next.args } : { text: "done" }
    },
    extraPlugins: [join(import.meta.dir, "../src/index.ts")],
  })
  symlinkSync(join(host.root, "config"), join(host.root, "home", ".config"))
})

afterAll(async () => {
  await host.stop()
})

const write = (dir: string, content = "edited\n"): Step => ({ tool: "write", args: { path: `${dir}/AGENTS.md`, content } })
const ask = (question = QUESTION): Step => ({
  tool: "question",
  args: { questions: [{ header: "AGENTS.md edit", question, options: [{ label: "Yes", description: "apply" }, { label: "No", description: "skip" }] }] },
})

const run = async (testPlan: Plan, answer: string | undefined, prompts = 1, directory?: string) => {
  const agents = join(host.configDir, "AGENTS.md")
  const repoAgents = join(host.project, "AGENTS.md")
  writeFileSync(agents, ORIGINAL)
  writeFileSync(repoAgents, ORIGINAL)
  rmSync(join(host.project, "pkg"), { recursive: true, force: true })
  plan = testPlan
  const firstCall = host.fixture.calls.length
  const session = await host.session("build", directory)
  let forms = 0
  for (let i = 0; i < prompts; i++) {
    await host.prompt(session, `prompt ${i}`)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const pending = (await host.json("GET", `/api/session/${session.id}/form`)) as { data?: { id: string; state?: { status?: string } }[] } | { id: string }[]
      const list = Array.isArray(pending) ? pending : (pending.data ?? [])
      const open = list.filter((form: any) => !form.state || form.state.status === "pending")
      for (const form of open) {
        forms++
        await host.json("POST", `/api/session/${session.id}/form/${form.id}/reply`, { answer: { q0: answer ?? "No" } })
      }
      const messages = await host.messages(session)
      if (messages.at(-1)?.type === "idle" && open.length === 0) break
      await Bun.sleep(200)
    }
  }
  const results = host.fixture.calls.slice(firstCall).flatMap((c) => c.request.messages).filter((m) => m.role === "tool").map(text)
  return {
    changed: readFileSync(agents, "utf8") !== ORIGINAL,
    repoChanged: readFileSync(repoAgents, "utf8") !== ORIGINAL,
    forms,
    denied: results.some((r) => r.includes(DENIED)),
    results,
  }
}

test.each<[string, (dir: string) => string]>([
  ["cat", (dir) => `cat "${dir}/AGENTS.md"`],
  ["cat via home", () => "cat ~/.config/opencode/AGENTS.md"],
  ["head", (dir) => `head -n 1 "${dir}/AGENTS.md"`],
  ["tail", (dir) => `tail -n 1 "${dir}/AGENTS.md"`],
  ["grep", (dir) => `grep -n Global "${dir}/AGENTS.md"`],
  ["git diff", (dir) => `git diff --no-index -- /dev/null "${dir}/AGENTS.md"`],
  ["git diff context", (dir) => `git diff --no-index -U3 -- /dev/null "${dir}/AGENTS.md"`],
])("a read-only shell %s returns the protected file without approval", async (_name, command) => {
  const outcome = await run((dir) => [[{ tool: "shell", args: { command: command(dir) } }]], undefined)
  expect(outcome).toMatchObject({ changed: false, repoChanged: false, denied: false, forms: 0 })
  expect(outcome.results.join("\n")).toContain("# Global rules")
}, 60_000)

test.each<[string, (dir: string) => string]>([
  ["a read followed by an append", (dir) => `cat "${dir}/AGENTS.md" && printf x >> "${dir}/AGENTS.md"`],
  ["a read with an output redirect", (dir) => `cat "${dir}/AGENTS.md" > "${dir}/AGENTS.md"`],
  ["a read with a writing substitution", (dir) => `cat "$(printf x >> '${dir}/AGENTS.md'; printf %s '${dir}/AGENTS.md')"`],
  ["a read followed by a newline writer", (dir) => `cat "${dir}/AGENTS.md"\nprintf x >> "${dir}/AGENTS.md"`],
  ["a read piped into a writer", (dir) => `cat "${dir}/AGENTS.md" | tee "${dir}/AGENTS.md"`],
  ["sed with a write script", (dir) => `sed 'w ${dir}/AGENTS.md' "${dir}/notes.md"`],
  ["git diff with an output file", (dir) => `git diff --no-index --output="${dir}/AGENTS.md" /dev/null "${dir}/notes.md"`],
  ["git diff with a separate output option", (dir) => `git diff --no-index --output "${dir}/AGENTS.md" /dev/null "${dir}/notes.md"`],
])("%s remains denied without approval", async (_name, command) => {
  writeFileSync(join(host.configDir, "notes.md"), "new rules\n")
  const outcome = await run((dir) => [[{ tool: "shell", args: { command: command(dir) } }]], undefined)
  expect(outcome).toMatchObject({ changed: false, repoChanged: false, denied: true, forms: 0 })
}, 60_000)

test("git status can inspect a protected path without approval", async () => {
  expect(Bun.spawnSync(["git", "init", "--quiet", host.project]).exitCode).toBe(0)
  const outcome = await run(() => [[{ tool: "shell", args: { command: "git status --short -- AGENTS.md" } }]], undefined)
  expect(outcome).toMatchObject({ changed: false, repoChanged: false, denied: false, forms: 0 })
  expect(outcome.results.join("\n")).toContain("?? AGENTS.md")
}, 60_000)

test("a recognized shell read cannot override a configured deny", async () => {
  let calls = 0
  const isolated = await Host.start({
    extraPlugins: [join(import.meta.dir, "../src/index.ts")],
    configFiles: { "AGENTS.md": ORIGINAL },
    permissions: () => [{ action: "shell", resource: "cat *", effect: "deny" }],
    script: () => calls++ === 0
      ? { tool: "shell", args: { command: `cat "${isolated.configDir}/AGENTS.md"` } }
      : { text: "done" },
  })
  try {
    const session = await isolated.session()
    await isolated.prompt(session, "Inspect the protected file")
    await isolated.settle(session)
    const results = isolated.fixture.calls.flatMap((call) => call.request.messages).filter((message) => message.role === "tool").map(text).join("\n")
    expect(results).toContain("permission.rejected")
    expect(results).not.toContain("# Global rules")
    expect(readFileSync(join(isolated.configDir, "AGENTS.md"), "utf8")).toBe(ORIGINAL)
  } finally {
    await isolated.stop()
  }
}, 60_000)

test("an edit without a question is denied", async () => {
  const outcome = await run((d) => [[write(d)]], undefined)
  expect(outcome).toMatchObject({ changed: false, denied: true })
}, 60_000)

test("Yes to the exact question allows the edit", async () => {
  const outcome = await run((d) => [[write(d), ask(), write(d)]], "Yes")
  expect(outcome).toMatchObject({ changed: true, forms: 1 })
}, 60_000)

test("a shell read does not approve a later shell write", async () => {
  const outcome = await run((dir) => [[
    { tool: "shell", args: { command: `cat "${dir}/AGENTS.md"` } },
    { tool: "shell", args: { command: `printf x >> "${dir}/AGENTS.md"` } },
  ]], undefined)
  expect(outcome).toMatchObject({ changed: false, repoChanged: false, denied: true, forms: 0 })
  expect(outcome.results.join("\n")).toContain("# Global rules")
}, 60_000)

test("Yes allows a shell write until the next user message", async () => {
  const outcome = await run((dir) => [
    [ask(), { tool: "shell", args: { command: `printf approved >> "${dir}/AGENTS.md"` } }],
    [{ tool: "shell", args: { command: `printf revoked >> "${dir}/AGENTS.md"` } }],
  ], "Yes", 2)
  expect(readFileSync(join(host.configDir, "AGENTS.md"), "utf8")).toBe("# Global rules\napproved")
  expect(outcome).toMatchObject({ changed: true, repoChanged: false, denied: true, forms: 1 })
}, 60_000)

test("No keeps it denied", async () => {
  const outcome = await run((d) => [[ask(), write(d)]], "No")
  expect(outcome).toMatchObject({ changed: false, forms: 1 })
}, 60_000)

test("a custom answer keeps it denied", async () => {
  const outcome = await run((d) => [[ask(), write(d)]], "Yes, but only the first line")
  expect(outcome.changed).toBe(false)
}, 60_000)

test("Yes to a different question keeps it denied", async () => {
  const outcome = await run((d) => [[ask("Shall I continue?"), write(d)]], "Yes")
  expect(outcome).toMatchObject({ changed: false, forms: 1 })
}, 60_000)

test("the approval ends at the user's next message", async () => {
  const outcome = await run((d) => [[ask(), write(d, "first\n")], [write(d, "second\n")]], "Yes", 2)
  expect(readFileSync(join(host.configDir, "AGENTS.md"), "utf8")).toBe("first\n")
  expect(outcome.changed).toBe(true)
}, 60_000)

test.each<[string, (d: string) => Step]>([
  ["edit tool, absolute path", (d) => ({ tool: "edit", args: { path: `${d}/AGENTS.md`, oldString: "Global", newString: "X" } })],
  ["shell append, absolute path", (d) => ({ tool: "shell", args: { command: `printf x >> ${d}/AGENTS.md` } })],
  ["shell append via ~ path", () => ({ tool: "shell", args: { command: "printf x >> ~/.config/opencode/AGENTS.md" } })],
  ["shell sed -i via cd", (d) => ({ tool: "shell", args: { command: `cd ${d} && sed -i '' s/Global/X/ AGENTS.md` } })],
])("%s is denied", async (_name, step) => {
  const outcome = await run((d) => [[step(d)]], undefined)
  expect(outcome).toMatchObject({ changed: false, denied: true })
}, 60_000)

test.each<[string, Step]>([
  ["edit tool, relative path", { tool: "edit", args: { path: "AGENTS.md", oldString: "Global", newString: "X" } }],
  ["shell append, relative path", { tool: "shell", args: { command: "printf x >> AGENTS.md" } }],
])("%s inside the config dir is denied", async (_name, step) => {
  const outcome = await run(() => [[step]], undefined, 1, host.configDir)
  expect(outcome).toMatchObject({ changed: false, denied: true })
}, 60_000)

test("other files and reads are not affected", async () => {
  writeFileSync(join(host.configDir, "notes.md"), "a\n")
  const outcome = await run((d) => [[{ tool: "write", args: { path: `${d}/notes.md`, content: "b\n" } }, { tool: "read", args: { path: `${d}/AGENTS.md` } }]], undefined)
  expect(readFileSync(join(host.configDir, "notes.md"), "utf8")).toBe("b\n")
  expect(outcome).toMatchObject({ changed: false, denied: false })
}, 60_000)

describe("AGENTS.md in repos", () => {
  test("an absolute write to a repo AGENTS.md is denied", async () => {
    const outcome = await run(() => [[{ tool: "write", args: { path: join(host.project, "AGENTS.md"), content: "x\n" } }]], undefined)
    expect(outcome).toMatchObject({ repoChanged: false, denied: true })
  }, 60_000)

  test("a relative edit inside a repo is denied", async () => {
    const outcome = await run(() => [[{ tool: "edit", args: { path: "AGENTS.md", oldString: "Global", newString: "X" } }]], undefined, 1, host.project)
    expect(outcome).toMatchObject({ repoChanged: false, denied: true })
  }, 60_000)

  test("a shell append inside a repo is denied", async () => {
    const outcome = await run(() => [[{ tool: "shell", args: { command: "printf x >> AGENTS.md" } }]], undefined, 1, host.project)
    expect(outcome).toMatchObject({ repoChanged: false, denied: true })
  }, 60_000)

  test("creating a new AGENTS.md in a subfolder is denied", async () => {
    const created = join(host.project, "pkg", "AGENTS.md")
    const outcome = await run(() => [[{ tool: "write", args: { path: created, content: "x\n" } }]], undefined)
    expect(outcome.denied).toBe(true)
    expect(existsSync(created)).toBe(false)
  }, 60_000)

  test("a different letter case is denied", async () => {
    const outcome = await run(() => [[{ tool: "write", args: { path: join(host.project, "pkg", "agents.md"), content: "x\n" } }]], undefined)
    expect(outcome.denied).toBe(true)
    expect(existsSync(join(host.project, "pkg", "agents.md"))).toBe(false)
  }, 60_000)

  test("Yes to the question allows a repo edit", async () => {
    const outcome = await run(() => [[ask(), { tool: "write", args: { path: join(host.project, "AGENTS.md"), content: "x\n" } }]], "Yes")
    expect(outcome).toMatchObject({ repoChanged: true, forms: 1 })
  }, 60_000)

  test("other repo files are not affected", async () => {
    const readme = join(host.project, "README.md")
    const outcome = await run(() => [[{ tool: "write", args: { path: readme, content: "hello\n" } }]], undefined)
    expect(readFileSync(readme, "utf8")).toBe("hello\n")
    expect(outcome.denied).toBe(false)
  }, 60_000)
})
