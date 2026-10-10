import { expect, test } from "bun:test"
import { isSupportedReadCommand } from "../src/read-only-shell.ts"

test.each([
  "cat AGENTS.md",
  "cat ~/AGENTS.md",
  "cat ~/.config/opencode/AGENTS.md",
  " \tcat\t-n AGENTS.md \t",
  "cat -benstuvAET -- AGENTS.md",
  "cat 'folder with spaces/AGENTS.md'",
  'cat "folder with spaces/AGENTS.md"',
  "cat -- '-AGENTS.md'",
  "cat 'literal > | & ; ( ) # $ ` \\ AGENTS.md'",
  'cat "literal > | & ; ( ) # AGENTS.md"',
  "cat agents.MD",
  "cat -- -n AGENTS.md",
  "head -n 10 AGENTS.md",
  "head -c 0 -- AGENTS.md",
  "tail -n 1 AGENTS.md",
  "tail -c 100 AGENTS.md",
  "wc -clmwL -- AGENTS.md",
  "grep -n Global AGENTS.md",
  "grep -Fivn 'a && b' AGENTS.md",
  "grep -e '-Global' -- '-AGENTS.md'",
  "grep -e '' -e 'rules' AGENTS.md",
  "grep -- '-Global' AGENTS.md",
  "sed -n p AGENTS.md",
  "sed -n '1p' AGENTS.md",
  'sed -n "1,20p" -- AGENTS.md',
  "git diff -- AGENTS.md",
  "git diff --stat HEAD -- AGENTS.md",
  "git diff --unified=2 -- AGENTS.md",
  "git diff -U3 -- AGENTS.md",
  "git show -U3 HEAD:AGENTS.md",
  "git log -U3 -- AGENTS.md",
  'git diff --no-index -- /dev/null "folder with spaces/AGENTS.md"',
  "git diff --no-index /dev/null AGENTS.md",
  "git diff -- --output=AGENTS.md",
  "git --no-pager -C 'repo with spaces' diff -- AGENTS.md",
  "git -C . --no-pager status --short -- AGENTS.md",
  "git status --porcelain=v2 -- AGENTS.md",
  "git show --oneline HEAD:AGENTS.md",
  "git show --name-only HEAD -- AGENTS.md",
  "git log --oneline -n 5 -- AGENTS.md",
  "git log --max-count=2 -- AGENTS.md",
  "git ls-files --stage -- AGENTS.md",
  "git ls-files --others --exclude-standard -- AGENTS.md",
])("supports a literal reader %j", (command) => {
  expect(isSupportedReadCommand(command)).toBe(true)
})

test.each([
  "", " \t", "cat", "head AGENTS.md -n", "head -n -1 AGENTS.md", "head -n +1 AGENTS.md",
  "tail -f AGENTS.md", "tail -n 1x AGENTS.md", "cat --unknown AGENTS.md", "cat -w AGENTS.md",
  "wc --files0-from=AGENTS.md", "grep -f AGENTS.md notes.md", "grep --unknown x AGENTS.md", "grep -e",
  "sed -i '' '1p' AGENTS.md", "sed -n -f AGENTS.md", "sed -n 'w AGENTS.md' notes.md",
  "sed -n '1w AGENTS.md' notes.md", "sed -n 'e printf x' AGENTS.md", "sed -n 's/a/b/w AGENTS.md' notes.md",
  "sed -n 'p;w AGENTS.md' notes.md", "sed -n '1pe' AGENTS.md", "sed -n '1,2pw AGENTS.md' notes.md",
  "sed -n '0p' AGENTS.md", "sed -n '$p' AGENTS.md", "sed -n '1p' -i AGENTS.md",
  "git diff --output AGENTS.md", "git diff --output=AGENTS.md", "git diff --ext-diff -- AGENTS.md",
  "git -c diff.external=writer diff -- AGENTS.md", "git --config-env=x=y diff -- AGENTS.md",
  "git --paginate diff -- AGENTS.md", "git -C . -C other diff -- AGENTS.md", "git -C",
  "git --no-pager --no-pager diff -- AGENTS.md", "git diff --unknown AGENTS.md",
  "git diff --no-index AGENTS.md", "git diff --no-index a b AGENTS.md", "git diff --unified=x AGENTS.md",
  "git diff -U 3 -- AGENTS.md", "git diff --unified 3 -- AGENTS.md", "git diff -U=3 -- AGENTS.md",
  "git show -U 3 HEAD:AGENTS.md", "git log --unified 3 -- AGENTS.md",
  "git log --max-count", "git show --format=x AGENTS.md", "git ls-files --with-tree AGENTS.md",
  "git status --output=AGENTS.md", "git checkout -- AGENTS.md", "git alias -- AGENTS.md",
  "rg AGENTS.md", "rg --no-config --pre writer AGENTS.md", "rg --no-config --hostname-bin writer AGENTS.md",
  "env cat AGENTS.md", "command cat AGENTS.md", "sudo cat AGENTS.md", "sh -c 'cat AGENTS.md'",
  "python -c 'print(\"AGENTS.md\")'", "/bin/cat AGENTS.md", "./cat AGENTS.md", "CAT AGENTS.md",
  "X=1 cat AGENTS.md", "cat AGENTS.md X=1", "cat =cat AGENTS.md", "cat ~user/AGENTS.md", "cat AGENTS.md # comment",
  "cat ~+/AGENTS.md", "cat ~/$(touch AGENTS.md)",
  "cat AGENTS.md;", "cat AGENTS.md && printf x >> AGENTS.md", "cat AGENTS.md || true",
  "cat AGENTS.md | tee AGENTS.md", "cat AGENTS.md &", "(cat AGENTS.md)", "{ cat AGENTS.md; }",
  "cat AGENTS.md\nprintf x >> AGENTS.md", "cat AGENTS.md\r", "cat AGENTS.md\0",
  "cat $FILE/AGENTS.md", 'cat "${FILE}/AGENTS.md"', 'cat "$(touch AGENTS.md)"',
  "cat `touch AGENTS.md`", 'cat "`touch AGENTS.md`"', "cat <(touch AGENTS.md)", "cat >(touch AGENTS.md)",
  "cat AGENTS.md*", "cat AGENTS.md?", "cat [A]GENTS.md", "cat {AGENTS.md,notes.md}",
  "cat 'AGENTS.md", 'cat "AGENTS.md', "cat 'AGENTS'.md", "cat AGENTS'.md'", "cat 'AGENTS.md'\"\"",
  "cat AGENTS\\.md", 'cat "AGENTS\\.md"', "cat\vAGENTS.md", "cat AGENTS.md\u00a0",
])("rejects unsupported or unsafe syntax %j", (command) => {
  expect(isSupportedReadCommand(command)).toBe(false)
})

test.each([
  "cat AGENTS.md", "head -n 1 AGENTS.md", "tail -n 1 AGENTS.md", "wc -l AGENTS.md",
  "grep x AGENTS.md", "sed -n '1p' AGENTS.md", "git diff -- AGENTS.md", "git status --short -- AGENTS.md",
  "git show HEAD:AGENTS.md", "git log -- AGENTS.md", "git ls-files -- AGENTS.md",
])("rejects redirects and chained writers for %j", (reader) => {
  for (const suffix of [
    " > AGENTS.md", " >> AGENTS.md", " 2> AGENTS.md", " &> AGENTS.md", " <> AGENTS.md",
    " < AGENTS.md", " << AGENTS.md", " | tee AGENTS.md", " && printf x >> AGENTS.md",
    "\nprintf x >> AGENTS.md",
  ]) {
    expect(isSupportedReadCommand(reader + suffix)).toBe(false)
  }
})

test("rejects commands outside the literal grammar bounds", () => {
  expect(isSupportedReadCommand(`cat '${"a".repeat(16_384)}/AGENTS.md'`)).toBe(false)
  expect(isSupportedReadCommand(`cat ${"AGENTS.md ".repeat(256)}`)).toBe(false)
})
