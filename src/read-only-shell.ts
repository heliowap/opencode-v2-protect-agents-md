const literalArguments = (command: string): readonly string[] | undefined => {
  if (command.length > 16_384 || /[\r\n\0]/.test(command)) return
  const args: string[] = []
  let index = 0
  while (index < command.length) {
    if (command[index] === " " || command[index] === "\t") {
      index++
      continue
    }
    const start = index
    const quote = command[index]
    let word: string
    if (quote === "'" || quote === '"') {
      const end = command.indexOf(quote, index + 1)
      if (end < 0) return
      word = command.slice(index + 1, end)
      if (quote === '"' && /[$`\\]/.test(word)) return
      index = end + 1
      if (index < command.length && command[index] !== " " && command[index] !== "\t") return
    } else {
      while (index < command.length && command[index] !== " " && command[index] !== "\t") index++
      word = command.slice(start, index)
      if (!/^(?:~\/)?[A-Za-z0-9_./,:@%+=-]+$/.test(word) || /^(?:=|[A-Za-z_][A-Za-z0-9_]*=)/.test(word)) return
    }
    args.push(word)
    if (args.length > 256) return
  }
  return args.length ? args : undefined
}

const readFiles = (args: readonly string[], flags: RegExp, counts = false): boolean => {
  let paths = 0
  let options = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (options && arg === "--") {
      options = false
    } else if (options && counts && (arg === "-n" || arg === "-c")) {
      if (!/^[0-9]+$/.test(args[++index] ?? "")) return false
    } else if (options && arg.startsWith("-") && arg !== "-") {
      if (!flags.test(arg)) return false
    } else {
      if (!arg) return false
      paths++
    }
  }
  return paths > 0
}

const readGrep = (args: readonly string[]): boolean => {
  let pattern = false
  let paths = 0
  let options = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (options && arg === "--") {
      options = false
    } else if (options && arg === "-e") {
      if (args[++index] === undefined) return false
      pattern = true
    } else if (options && arg.startsWith("-") && arg !== "-") {
      if (!/^-[EFGivnclLhHoqswxaI]+$/.test(arg)) return false
    } else if (!pattern) {
      pattern = true
    } else {
      if (!arg) return false
      paths++
    }
  }
  return pattern && paths > 0
}

const readSed = (args: readonly string[]): boolean => {
  if (args[0] !== "-n" || !/^(?:p|[1-9][0-9]*(?:,[1-9][0-9]*)?p)$/.test(args[1] ?? "")) return false
  return readFiles(args.slice(2), /^$/)
}

const diffFlags = [
  "-p", "--patch", "--no-patch", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status",
  "--summary", "--check", "--quiet", "--exit-code", "--no-color", "--color=never", "--no-ext-diff", "--no-textconv",
]
const gitProfiles = new Map<string, { flags: ReadonlySet<string>; numbers: ReadonlySet<string> }>([
  ["diff", { flags: new Set([...diffFlags, "--no-index", "--cached", "--staged", "--raw"]), numbers: new Set(["-U", "--unified"]) }],
  ["status", { flags: new Set([
    "-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-z",
    "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all",
  ]), numbers: new Set() }],
  ["show", { flags: new Set([...diffFlags, "--oneline", "-s"]), numbers: new Set(["-U", "--unified"]) }],
  ["log", { flags: new Set([
    ...diffFlags, "--oneline", "--no-decorate", "--decorate=short", "--decorate=full", "--all",
  ]), numbers: new Set(["-n", "--max-count", "-U", "--unified"]) }],
  ["ls-files", { flags: new Set([
    "-c", "--cached", "-d", "--deleted", "-m", "--modified", "-o", "--others", "-i", "--ignored",
    "--exclude-standard", "-s", "--stage", "-u", "--unmerged", "--error-unmatch", "--full-name", "-z",
  ]), numbers: new Set() }],
])

const readGit = (args: readonly string[]): boolean => {
  let index = 0
  let directory = false
  let noPager = false
  while (index < args.length) {
    if (args[index] === "--no-pager" && !noPager) {
      noPager = true
      index++
    } else if (args[index] === "-C" && !directory) {
      directory = true
      const path = args[++index]
      if (!path || path.startsWith("-")) return false
      index++
    } else {
      break
    }
  }
  const subcommand = args[index++]
  const profile = gitProfiles.get(subcommand ?? "")
  if (!profile) return false
  let options = true
  let noIndex = false
  let operands = 0
  for (; index < args.length; index++) {
    const arg = args[index]!
    if (options && arg === "--") {
      options = false
    } else if (options && profile.flags.has(arg)) {
      if (arg === "--no-index") noIndex = true
    } else if (options && profile.numbers.has(arg)) {
      if (arg === "-U" || arg === "--unified") return false
      if (!/^[0-9]+$/.test(args[++index] ?? "")) return false
    } else if (options && arg.startsWith("-")) {
      if (profile.numbers.has("-U") && /^-U[0-9]+$/.test(arg)) continue
      const equal = arg.indexOf("=")
      if (!arg.startsWith("--") || equal < 0 || !profile.numbers.has(arg.slice(0, equal)) || !/^[0-9]+$/.test(arg.slice(equal + 1))) return false
    } else {
      if (!arg) return false
      operands++
    }
  }
  return !noIndex || operands === 2
}

const readers = new Map<string, (args: readonly string[]) => boolean>([
  ["cat", (args) => readFiles(args, /^-[benstuvAET]+$/)],
  ["head", (args) => readFiles(args, /^$/, true)],
  ["tail", (args) => readFiles(args, /^$/, true)],
  ["wc", (args) => readFiles(args, /^-[clmwL]+$/)],
  ["grep", readGrep],
  ["sed", readSed],
  ["git", readGit],
])

export const isSupportedReadCommand = (command: string): boolean => {
  const args = literalArguments(command)
  if (!args) return false
  return readers.get(args[0]!)?.(args.slice(1)) ?? false
}
