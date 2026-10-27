/**
 * `shellReadOperands` (bd tea-rags-mcp-ueplg): the files a Bash command reads
 * through `cat` / `sed` / `head` / `tail` / `less` / `more`, resolved against
 * the command's cwd — the operands the PreToolUse(Bash) hook checks against
 * the index. Null = the command cannot be read confidently; the hook fails
 * open.
 */

import { describe, expect, it } from "vitest";

import { shellReadOperands } from "../../../src/cli/commands/shell-read-operands.js";

const CWD = "/repo";

describe("shellReadOperands", () => {
  it("collects every reader operand of a compound command, resolved against the cwd", () => {
    expect(shellReadOperands("cat a.rb; sed -n 1,40p b.rb && head -n 20 /abs/c.ts || tail -5 d.py", CWD)).toEqual([
      "/repo/a.rb",
      "/repo/b.rb",
      "/abs/c.ts",
      "/repo/d.py",
    ]);
  });

  it("reads quoted operands and a redirected stdin file", () => {
    expect(shellReadOperands(`cat "my file.rb" 'x.rb' < in.rb`, CWD)).toEqual([
      "/repo/my file.rb",
      "/repo/x.rb",
      "/repo/in.rb",
    ]);
  });

  it("finds no operand in a pipe over command output", () => {
    expect(shellReadOperands("git diff | head -50", CWD)).toEqual([]);
    expect(shellReadOperands("npm test 2>&1 | tail -n 20 > out.log", CWD)).toEqual([]);
  });

  it("keeps the reader at the head of a pipeline", () => {
    expect(shellReadOperands("cat a.rb | grep def", CWD)).toEqual(["/repo/a.rb"]);
  });

  it("treats the first sed word as the script unless -e or -f carries it", () => {
    expect(shellReadOperands("sed 's/a/b/' x.rb", CWD)).toEqual(["/repo/x.rb"]);
    expect(shellReadOperands("sed -e 's/a/b/' y.rb", CWD)).toEqual(["/repo/y.rb"]);
    expect(shellReadOperands("sed -ne '1,5p' z.rb", CWD)).toEqual(["/repo/z.rb"]);
  });

  it("skips sed -i, which edits rather than reads", () => {
    expect(shellReadOperands("sed -i '' 's/a/b/' x.rb", CWD)).toEqual([]);
  });

  it("follows a literal cd before a relative operand", () => {
    expect(shellReadOperands("cd sub && cat a.rb", CWD)).toEqual(["/repo/sub/a.rb"]);
  });

  it("skips env assignments before the reader", () => {
    expect(shellReadOperands("LC_ALL=C cat a.rb", CWD)).toEqual(["/repo/a.rb"]);
  });

  it("skips operands it cannot resolve: variables, globs, home paths, stdin", () => {
    expect(shellReadOperands("cat $FILE *.rb ~/x.rb - real.rb", CWD)).toEqual(["/repo/real.rb"]);
  });

  it("answers null for a command it cannot read confidently", () => {
    expect(shellReadOperands("cat $(git ls-files)", CWD)).toBeNull();
    expect(shellReadOperands("cat `ls`", CWD)).toBeNull();
    expect(shellReadOperands("cat <<EOF\nx\nEOF", CWD)).toBeNull();
    expect(shellReadOperands(`cat "unterminated`, CWD)).toBeNull();
  });

  it("finds nothing in a command with no reader", () => {
    expect(shellReadOperands("ls -la src && git status", CWD)).toEqual([]);
  });
});
