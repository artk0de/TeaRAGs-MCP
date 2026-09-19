/**
 * No tracked text file carries a raw NUL byte (bd tea-rags-mcp-k8gac).
 *
 * A composite-key separator written as the literal 0x00 character instead of
 * the escape `"\0"` compiles to the same string, so no test notices. What
 * notices is everything that classifies files by content: git sees a NUL and
 * treats the file as binary — `git diff` prints `Bin`, `git log --numstat`
 * gives `-\t-`, a three-way text merge is impossible — so TeaRAGs' line-churn
 * git signals vanish for that file, and ripgrep skips it by default. Measured
 * when this guard landed: the `OmittedOverlayKeyCollector` signature join plus
 * four earlier dedup/memo keys under `src/` and `tests/`, and three more in
 * `scripts/`, each invisible to history and search since. The usual origin is
 * a file-write tool call: an agent types the six-character unicode escape for
 * code point zero, and the call's JSON decoding delivers the byte itself.
 *
 * The escape is the same runtime value and keeps the file text, so the fix is
 * always mechanical. `"\0"` is safe only when the next character is not a
 * digit (`"\01"` is a legacy octal escape, and a syntax error in a template
 * literal); spell it `"\x00"` there.
 *
 * Every tracked text file, not only TypeScript: the same incident put the byte
 * into two plan documents, and a `.md`, `.mjs`, `.sh` or `.json` file turns
 * binary to git just the same. "Text" is every path `isNulGuardedPath` does not
 * name as a binary format (`scripts/lib/nul-bytes.ts` says why git's own
 * classification cannot be used). This scan runs in the full suite; the
 * per-commit check is `scripts/check-staged-nul-bytes.ts` in `.husky/pre-commit`,
 * because `vitest related` never selects this file for a commit that does not
 * stage it.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeNulByteOffense,
  findRawNulBytes,
  isNulGuardedPath,
  NUL_BYTE_FIX_HINT,
} from "../scripts/lib/nul-bytes.js";

const ROOT = join(import.meta.dirname, "..");

const NUL = 0x00;

/**
 * Tracked text files present on disk, repo-relative with POSIX separators. A
 * symlink is skipped: git records its target path, and reading it would follow
 * the link to an untracked file (`bin/tea-rags` → the build output).
 */
function trackedTextFiles(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return listing
    .split(String.fromCharCode(NUL))
    .filter((path) => path !== "" && isNulGuardedPath(path))
    .filter((path) => {
      try {
        return lstatSync(join(ROOT, path)).isFile();
      } catch {
        return false; // deleted in the working tree
      }
    })
    .sort();
}

describe("findRawNulBytes", () => {
  it("flags a raw NUL byte with its line and column", () => {
    const content = Buffer.concat([
      Buffer.from("const a = 1;\nconst key = a + '"),
      Buffer.from([NUL]),
      Buffer.from("' + b;\n"),
    ]);
    expect(findRawNulBytes(content)).toEqual([{ line: 2, column: 18 }]);
  });

  it("reports every byte on a line", () => {
    expect(findRawNulBytes(Buffer.from([0x61, NUL, 0x62, NUL]))).toEqual([
      { line: 1, column: 2 },
      { line: 1, column: 4 },
    ]);
  });

  it.each([
    ["the escape", String.raw`omitted.join("\0")`],
    ["the hex escape", String.raw`const key = a + "\x00" + b;`],
    ["a word naming the byte", "// joined on a NUL separator"],
  ])("leaves %s alone", (_label, source) => {
    expect(findRawNulBytes(Buffer.from(source))).toEqual([]);
  });
});

describe("tracked text files", () => {
  it("finds the files to scan — every text kind, no binary one", () => {
    const files = trackedTextFiles();
    for (const path of [
      "src/core/domains/ingest/errors.ts",
      ".husky/pre-commit",
      ".claude-plugin/tea-rags/rules/search-cascade.md",
      "package.json",
      ".claude-plugin/tea-rags/scripts/inject-rules.sh",
    ]) {
      expect(files).toContain(path);
    }
    expect(files.some((path) => path.startsWith("docs/superpowers/plans/"))).toBe(true);
    expect(files.some((path) => path.endsWith(".mjs"))).toBe(true);
    expect(files).not.toContain("public/logo.png");
    expect(files).not.toContain("bin/tea-rags");
  });

  it("carry no raw NUL byte — write the separator as an escape", () => {
    const offenses = trackedTextFiles().flatMap((path) =>
      findRawNulBytes(readFileSync(join(ROOT, path))).map((offense) => describeNulByteOffense({ path, ...offense })),
    );
    // Joined, not compared as an array: vitest truncates a long array diff to its
    // length, and the whole point of the failure is the list of places to fix.
    expect(offenses.join("\n"), `${offenses.length} raw NUL byte(s); ${NUL_BYTE_FIX_HINT}`).toBe("");
  });
});
