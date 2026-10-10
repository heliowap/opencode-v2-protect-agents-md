import { Plugin } from "@opencode/plugin"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { isSupportedReadCommand } from "./read-only-shell.ts"

// Agents may edit any AGENTS.md (the global one and every repo's, including new ones) only after
// the user answers "Yes" to QUESTION through the question tool, and only until the user's next
// message in that session. Edits are denied rather than asked because an auto-accepting client
// approves every permission ask; the question form is answered by the user. Shell commands are
// matched on their raw text, because the permission scanner does not report redirection targets.
const FILE_NAME = "agents.md"
const QUESTION = "Do you want to proceed with editing AGENTS.md?"
const YES = "Yes"
const MESSAGE = [
  "AGENTS.md files are protected.",
  `Ask the user with the question tool: header "AGENTS.md edit", question exactly "${QUESTION}",`,
  `options "${YES}" (apply the edit) and "No" (leave it unchanged).`,
  `Retry the edit only after the answer "${YES}". If you cannot use the question tool, report this to your parent.`,
].join(" ")
const MENTIONS_FILE = /agents\.md/i

interface QuestionInput {
  readonly questions?: ReadonlyArray<{ readonly question?: unknown }>
}

const canonical = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)

export default Plugin.define({
  id: "protect-agents-md",
  async setup(ctx) {
    const flaggedShellCalls = new Set<string>()
    const unlocked = new Set<string>()

    const isProtected = (path: string) =>
      basename(canonical(resolve(ctx.location.directory, expandHome(path)))).toLowerCase() === FILE_NAME

    await ctx.session.hook("prompt", (event) => {
      unlocked.delete(event.sessionID)
    })

    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "shell" || typeof event.input !== "object" || event.input === null) return
      const { command } = event.input as { command?: unknown }
      if (typeof command === "string" && MENTIONS_FILE.test(command) && !isSupportedReadCommand(command)) flaggedShellCalls.add(event.id)
    })

    await ctx.tool.hook("execute.after", (event) => {
      flaggedShellCalls.delete(event.id)
      if (event.tool !== "question" || event.status !== "completed") return
      const questions = (event.input as QuestionInput | undefined)?.questions ?? []
      const answers = (event.result.metadata as { answers?: unknown } | undefined)?.answers
      if (!Array.isArray(answers)) return
      const approved = questions.some((question, index) => {
        const answer = answers[index]
        return question.question === QUESTION && Array.isArray(answer) && answer.length === 1 && answer[0] === YES
      })
      if (approved) unlocked.add(event.sessionID)
    })

    await ctx.permission.hook("evaluate", (event) => {
      if (event.effect === "deny" || unlocked.has(event.sessionID)) return
      const flagged =
        (event.action === "edit" && event.resources.some(isProtected)) ||
        (event.action === "shell" && event.source?.type === "tool" && flaggedShellCalls.has(event.source.id))
      if (!flagged) return
      event.effect = "deny"
      event.message = MESSAGE
    })
  },
})
