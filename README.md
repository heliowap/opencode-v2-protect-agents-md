# opencode-v2-protect-agents-md

An OpenCode v2 plugin that stops agents from editing any `AGENTS.md` without
your explicit approval: the global one (`~/.config/opencode/AGENTS.md`) and
every repo's, including creating a new one.

For Cursor Agent CLI, Codex CLI, and Claude Code on macOS, use the
[process launcher](docs/process-guard.md). It rejects local protected writes
for the entire process tree. Unlike the OpenCode plugin, it has no temporary
approval or in-session unlock. The Cursor IDE is not covered.

## Run a protected CLI on macOS

Install Bun and the client CLI. Run the launcher from your working project,
using the absolute path to this checkout's entry point.

```sh
bun /path/to/opencode-v2-protect-agents-md/bin/protect-agents.ts --client cursor
bun /path/to/opencode-v2-protect-agents-md/bin/protect-agents.ts --client codex
bun /path/to/opencode-v2-protect-agents-md/bin/protect-agents.ts --client claude
```

Put client arguments after `--`. Use `--binary` for a custom executable.
Use repeated `--protect` arguments for additional physical files or existing
symlinks whose targets have ordinary names.

```sh
bun /path/to/opencode-v2-protect-agents-md/bin/protect-agents.ts --client codex --protect ./nested/AGENTS.md -- --model gpt-6.1-sol
```

The launcher does not install hooks or change your global configuration.
To edit a protected file, use an editor outside the launched process tree.
There is no automatic approval based on an agent's answer.

## OpenCode behavior


- **Denied by default.** The plugin denies:
  - `edit` permissions (edit, write, patch) whose target file is named
    `AGENTS.md` in any letter case, in any directory, including relative paths,
    `~` paths, symlinks and files that do not exist yet;
  - shell commands whose text mentions `AGENTS.md` in any letter case,
    unless the complete command matches a supported read-only form.

  The denial message tells the agent to ask you first.
- **Approval.** The agent must ask through the question tool, with exactly
  this question: "Do you want to proceed with editing AGENTS.md?".
  Only the answer `Yes` (that option alone, not a custom answer) unlocks edits.
- **Scope of the approval.** It applies to every `AGENTS.md` in that session
  only, and lasts until your next message in it.
- **Works with `session.permissions: autoaccept`.** The plugin denies instead
  of asking, so an auto-accepting client cannot approve the edit for you.
- **Shell reads.** Supported single-command forms include `cat`, `head`, `tail`,
  `wc`, `grep`, restricted `sed -n` print scripts, and selected Git inspection
  commands. Literal quoted paths and bare `~/` paths are supported.
  Unknown commands or options, redirects, pipes, command chains, and command
  substitutions still need approval when they mention the protected file.
  A recognized read does not override other OpenCode permission rules or
  approve later writes.

## OpenCode limitations

- Shell matching is textual, with a bounded exception for supported reads.
  It is not a shell sandbox. The exception assumes standard executables and
  trusted inherited environment and configuration. Git diff helpers and
  text conversion can run configured programs.
- Commands such as `/init` that create or update `AGENTS.md` also need your
  `Yes`.
- Scripts that build the path indirectly (variables, string concatenation,
  another script) are not detected.

## Install the OpenCode plugin

Add the plugin to your OpenCode config:

```jsonc
{
  "plugins": ["github:heliowap/opencode-v2-protect-agents-md"]
}
```

If you already have a local copy (for example in
`~/.config/opencode/plugins/`), remove it so the plugin does not load twice.

## Development

```sh
bun install
bun run typecheck
bun test
```

The tests start a real `opencode serve` against a scripted model fixture, so
`opencode` must be on your `PATH` (or set `OPENCODE_BIN`).

Native process-enforcement tests run on macOS. Other systems skip that group.
The outbound-network assertion also requires `/usr/bin/python3` on macOS.
The [opt-in client tests](docs/process-guard.md#verification) require the
installed client CLIs and Python 3. They use disposable homes and loopback
model responses, not cloud models or real credentials.

## License

MIT
