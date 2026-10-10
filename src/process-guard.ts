import { lstatSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export const CLIENTS = {
  cursor: "cursor-agent",
  codex: "codex",
  claude: "claude",
} as const

export type Client = keyof typeof CLIENTS

export function sandboxArguments(protectedPaths: readonly string[], options: { loopbackOnly?: boolean } = {}): string[] {
  let profile = '(version 1)(allow default)(deny file-write* (regex #"/[Aa][Gg][Ee][Nn][Tt][Ss][.][Mm][Dd]$"))'
  const bindings: string[] = []
  const ancestors = new Set<string>()

  for (const [index, path] of protectedPaths.entries()) {
    if (path === "" || path.includes("\0")) {
      throw new Error("Protected paths must be nonempty and contain no null bytes")
    }

    let ancestor = resolve(path)
    const suffix: string[] = []
    let canonical: string

    while (true) {
      try {
        const physical = realpathSync(ancestor)
        if (suffix.length === 0) {
          const file = statSync(physical)
          if (file.isFile() && file.nlink > 1) {
            throw new Error(`Cannot protect a file with existing hardlinks: ${path}`)
          }
        }
        canonical = join(physical, ...suffix)
        break
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
        try {
          if (lstatSync(ancestor).isSymbolicLink()) {
            throw new Error(`Cannot protect an unresolved symbolic link: ${ancestor}`)
          }
        } catch (statError) {
          if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") throw statError
        }
        if (suffix.length > 0) {
          throw new Error(`Protected paths require an existing parent directory: ${path}`)
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) throw error
        suffix.unshift(basename(ancestor))
        ancestor = parent
      }
    }

    if (canonical === "/") throw new Error("The filesystem root cannot be a protected path")

    profile += `(deny file-write* (literal (param "protected${index}")))`
    bindings.push("-D", `protected${index}=${canonical}`)
    let directory = dirname(canonical)
    while (directory !== "/") {
      ancestors.add(directory)
      directory = dirname(directory)
    }
  }

  for (const [index, directory] of [...ancestors].entries()) {
    profile += `(deny file-write-unlink (literal (param "ancestor${index}")))`
    bindings.push("-D", `ancestor${index}=${directory}`)
  }

  if (options.loopbackOnly) {
    profile += '(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
  }

  return ["/usr/bin/sandbox-exec", "-p", profile, ...bindings]
}
