# macOS process guard

`bin/protect-agents.ts` starts Cursor Agent CLI, Codex CLI, or Claude Code
under a macOS file-write policy. Child processes inherit that policy.
The existing OpenCode plugin and its approval lifecycle remain unchanged.

## Protection

The OS denies file-write operations on physical paths whose basename is
`AGENTS.md`, ignoring letter case. Reads remain available. Unrelated writes
remain available. New protected files, deletion, and renaming to or from a
protected basename are also denied.

The launcher also selects these logical paths at startup:

- `AGENTS.md` in the launcher's working directory.
- `~/AGENTS.md`.
- `~/.config/opencode/AGENTS.md`.
- `~/.codex/AGENTS.md`.
- Each explicit `--protect` file.

Selected paths with existing parents resolve through symlinks to their physical targets.
The policy prevents removal or relocation of their ancestor directories.
It does not make all files beneath those directories read-only.
An explicit `--protect` file may be missing, but its parent directory must exist.
Default paths with missing parents still have basename protection, without a physical-target snapshot.
Dangling symlinks and selected files with existing hardlinks prevent launch.
Standard streams referring to selected protected files also prevent launch.
The launcher suppresses diagnostics in that case to avoid writing into them.
It also suppresses diagnostics and refuses launch when path or stream errors prevent
standard-stream safety checks.

Each launch first verifies an actual write denial on a disposable file.
If validation, policy compilation, that check, or sandbox entry fails, the
launcher does not retry without protection.

There is no temporary approval, question hook, grant file, or in-session unlock.
Manual edits from outside the protected process tree remain possible.

## Command reference

```sh
bun bin/protect-agents.ts --client cursor|codex|claude [--binary PATH] [--protect PATH] [--offline] -- [client arguments]
```

| Option | Behavior |
| --- | --- |
| `--client cursor` | Resolves `cursor-agent`, not the unrelated `agent` command or the Cursor IDE launcher. |
| `--client codex` | Resolves `codex`. |
| `--client claude` | Resolves `claude`. |
| `--binary PATH` | Overrides the CLI executable. The caller must choose an actual local client executable. |
| `--protect PATH` | Selects another file for physical-path protection. Repeatable. |
| `--offline` | Restricts outbound network connections to loopback addresses. Used by local model fixtures. |
| `--help` | Prints scope and syntax without launching a client. |
| `--` | Separates launcher options from untouched client arguments. |

The launcher inherits the environment, working directory, and standard streams.
It forwards interrupt and termination signals and preserves the client's exit status.
It does not modify settings, install plugins, alter authentication, or restart services.
The launcher needs Bun but no additional runtime package.

## Limits

This is a local write guardrail, not containment of a malicious same-user agent.

- Only processes started through the launcher and their descendants are covered.
  Existing IDE instances, ordinary unwrapped CLI sessions, external processes,
  and remote or MCP services outside that tree are not covered.
- The Cursor IDE, Windows, and Linux are unsupported.
- The launcher does not discover every symlink or hardlink on the filesystem.
  Select existing protected-name symlinks to ordinary targets with `--protect`.
  Preexisting aliases and descriptors for unselected files remain a gap.
- Canonical targets are a startup snapshot. Changes by outside processes,
  newly introduced external aliases, and filesystem races remain outside the guarantee.
- The launcher itself starts before sandbox entry. It is not an admin-owned
  policy or protection against changing its code and launching an unwrapped client.
- Restrictive nested sandboxes can reject a second sandbox entry.
  Such failures abort launch. The offline test profile composes network and
  file rules into one application instead of nesting them.
- Apple marks `sandbox-exec` deprecated and the profile language private.
  The tested system is macOS 26.5.2 on arm64. Other macOS versions are unverified.
  The startup denial check detects a failure of the basic write rule, not every OS change.

## Why hooks are insufficient in the tested versions

Offline real-client probes found these gaps before implementation:

| Client | Observed hook limitation |
| --- | --- |
| Cursor Agent CLI `2026.07.23-e383d2b` | Native Pi Write and Pi Edit execute without pre-tool hooks. |
| Codex CLI `0.160.0` | `write_stdin` does not repeat pre-tool hooks. User-configured `unified_exec = false` does not remove persistent execution. Missing hooks and an unsupported `ask` allowed writes in controls. |
| Claude Code `2.1.288` | Hook execution can be disabled. Programmatically supplied question answers do not attest human approval. |

The OS write policy does not depend on those tool hooks or their permission modes.
Native human-unlock parity would require a separate trusted approval mechanism.
No such mechanism is implemented here.

Primary sources describe the client contracts and their limits:

- [Cursor hooks](https://cursor.com/docs/hooks).
- [Codex hooks](https://developers.openai.com/codex/hooks).
- [Codex tagged pre-tool handling](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/hooks/src/events/pre_tool_use.rs).
- [Claude Code hooks](https://code.claude.com/docs/en/hooks).
- Local macOS `man sandbox-exec` and `man sandbox` describe deprecation,
  process inheritance, and already-open descriptors.

## Verification

Default tests include the existing OpenCode host tests, launch-plan tests, and
actual macOS process-tree tests. They check case variants, exact-name matching,
reads, writes, creation, deletion, renaming, symlinks, persistent child input,
ancestor relocation, hardlinks, standard streams, parameter injection, and exit status.

```sh
bun test
bun run typecheck
```

Opt-in E2E tests drive installed CLIs with scripted local model responses.
They build clean environments with fake credentials and OS-enforced loopback
networking. Successful unguarded controls prove each attempted write can occur.
Guarded runs assert native tool replies and actual file bytes.

```sh
python3 test/clients/cursor.py
python3 test/clients/codex.py
python3 test/clients/claude.py
```

Each script accepts `BUN_BIN` and its client override, respectively
`CURSOR_AGENT_BIN`, `CODEX_BIN`, or `CLAUDE_BIN`.

| Verified client | Cases |
| --- | --- |
| Cursor Agent CLI `2026.07.23-e383d2b` | Native Write, Delete, Pi Write, and Pi Edit controls and denials, protected Read, and unrelated Pi Write with `--force`. |
| Codex CLI `0.160.0` | Patches, direct append, persistent shell input, protected reads, unrelated patches, and explicit targets with native approvals and sandbox bypassed. |
| Claude Code `2.1.288` | Read, Write, Bash append, unrelated Write, and explicit targets with hooks disabled and native permissions bypassed. |

Cursor's fixture validates native BidiAppend replies, then terminates its
owned process group. It does not simulate a fully completed cloud conversation.
These are deterministic native-client tests, not formal model-based tests or
evidence of support for other client versions.
