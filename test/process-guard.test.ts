import { afterEach, beforeEach, expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { sandboxArguments } from "../src/process-guard.ts"

let directory: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "process-guard-")))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

test("generates a default basename policy without explicit path bindings", () => {
  expect(sandboxArguments([])).toEqual([
    "/usr/bin/sandbox-exec", "-p",
    '(version 1)(allow default)(deny file-write* (regex #"/[Aa][Gg][Ee][Nn][Tt][Ss][.][Mm][Dd]$"))',
  ])
})

test("binds existing files and locks their ancestors without denying unrelated descendant writes", () => {
  writeFileSync(join(directory, "one.txt"), "one")
  writeFileSync(join(directory, "two.txt"), "two")
  const args = sandboxArguments([join(directory, "one.txt"), join(directory, "two.txt")])
  expect(args).toContain(`protected0=${directory}/one.txt`)
  expect(args).toContain(`protected1=${directory}/two.txt`)
  expect(args).toContain(`ancestor0=${directory}`)
  expect(args[2]).toContain('(deny file-write-unlink (literal (param "ancestor0")))')
  expect(args[2]).not.toContain("subpath")
  expect(args.filter((arg) => arg === `ancestor0=${directory}`)).toHaveLength(1)
})

test("canonicalizes a file alias pointing to an ordinary basename", () => {
  writeFileSync(join(directory, "instructions.txt"), "seed")
  symlinkSync("instructions.txt", join(directory, "AGENTS.md"))
  expect(sandboxArguments([join(directory, "AGENTS.md")])).toContain(`protected0=${directory}/instructions.txt`)
})

test("canonicalizes a missing file through an existing directory alias without creating it", () => {
  mkdirSync(join(directory, "physical"))
  symlinkSync("physical", join(directory, "alias"))
  const args = sandboxArguments([join(directory, "alias", "instructions.txt")])
  expect(args).toContain(`protected0=${directory}/physical/instructions.txt`)
  expect(readdirSync(join(directory, "physical"))).toEqual([])
})

test("rejects missing parent directories instead of permitting future alias substitution", () => {
  expect(() => sandboxArguments([join(directory, "future", "policy.txt")])).toThrow("existing parent directory")
})

test("resolves a relative missing target against the working directory", () => {
  expect(sandboxArguments([relative(process.cwd(), join(directory, "new.txt"))])).toContain(`protected0=${directory}/new.txt`)
})

test("keeps hostile filename characters in parameter values instead of profile syntax", () => {
  const path = join(directory, 'quoted "file"\n(allow file-write*)\\name=value.txt')
  writeFileSync(path, "seed")
  const args = sandboxArguments([path])
  expect(args).toContain(`protected0=${path}`)
  expect(args[2]).not.toContain(path)
  expect(args[2]).toContain('(deny file-write* (literal (param "protected0")))')
})

test.each(["", "bad\0path"])("rejects invalid path %j", (path) => {
  expect(() => sandboxArguments([path])).toThrow("Protected paths must be nonempty and contain no null bytes")
})

test.each(["/", "/..", "//"])("rejects filesystem root %j", (path) => {
  expect(() => sandboxArguments([path])).toThrow("The filesystem root cannot be a protected path")
})

test("rejects an alias to the filesystem root", () => {
  symlinkSync("/", join(directory, "root"))
  expect(() => sandboxArguments([join(directory, "root")])).toThrow("The filesystem root cannot be a protected path")
})

test("rejects unresolved file and directory aliases", () => {
  symlinkSync("future.txt", join(directory, "AGENTS.md"))
  symlinkSync("future", join(directory, "alias"))
  expect(() => sandboxArguments([join(directory, "AGENTS.md")])).toThrow("unresolved symbolic link")
  expect(() => sandboxArguments([join(directory, "alias", "AGENTS.md")])).toThrow("unresolved symbolic link")
})

test("rejects selected files with existing hardlinks", () => {
  writeFileSync(join(directory, "AGENTS.md"), "seed")
  linkSync(join(directory, "AGENTS.md"), join(directory, "alias.txt"))
  expect(() => sandboxArguments([join(directory, "AGENTS.md")])).toThrow("existing hardlinks")
})

test("propagates filesystem errors rather than returning an unrestricted launch", () => {
  symlinkSync("loop", join(directory, "loop"))
  writeFileSync(join(directory, "file"), "seed")
  expect(() => sandboxArguments([join(directory, "loop")])).toThrow(/ELOOP/)
  expect(() => sandboxArguments([join(directory, "file", "child.txt")])).toThrow(/ENOTDIR/)
})

test("composes optional loopback-only networking in the same sandbox profile", () => {
  expect(sandboxArguments([], { loopbackOnly: true })).toEqual([
    "/usr/bin/sandbox-exec", "-p",
    '(version 1)(allow default)(deny file-write* (regex #"/[Aa][Gg][Ee][Nn][Tt][Ss][.][Mm][Dd]$"))' +
      '(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
  ])
})
