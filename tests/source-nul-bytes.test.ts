/**
 * Tracked TypeScript never carries a raw NUL byte (bd tea-rags-mcp-k8gac).
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
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Trees whose tracked `*.ts` files the guard scans. */
const SCANNED_ROOTS = ["src/", "tests/", "scripts/"] as const;

const NUL = 0x00;
const LINE_FEED = 0x0a;

interface NulByteOffense {
  /** 1-based line holding the byte. */
  line: number;
  /** 1-based byte column of the byte within that line. */
  column: number;
}

/** Every raw NUL byte in `content`, in file order. */
function findRawNulBytes(content: Uint8Array): NulByteOffense[] {
  const offenses: NulByteOffense[] = [];
  let line = 1;
  let lineStart = 0;
  for (let offset = 0; offset < content.length; offset++) {
    const byte = content[offset];
    if (byte === NUL) offenses.push({ line, column: offset - lineStart + 1 });
    if (byte === LINE_FEED) {
      line++;
      lineStart = offset + 1;
    }
  }
  return offenses;
}

/** Tracked `*.ts` files under {@link SCANNED_ROOTS}, repo-relative with POSIX separators. */
function trackedTypeScriptFiles(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "--", "*.ts"], { cwd: ROOT, encoding: "utf8" });
  return listing
    .split(String.fromCharCode(NUL))
    .filter((path) => SCANNED_ROOTS.some((root) => path.startsWith(root)))
    .filter((path) => existsSync(join(ROOT, path)))
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

describe("tracked TypeScript sources", () => {
  it("finds the files to scan", () => {
    expect(trackedTypeScriptFiles().length).toBeGreaterThan(0);
  });

  it("carry no raw NUL byte — write the separator as an escape", () => {
    const offenses = trackedTypeScriptFiles().flatMap((path) =>
      findRawNulBytes(readFileSync(join(ROOT, path))).map(
        (offense) => `${path} line ${offense.line}, byte ${offense.column}`,
      ),
    );
    // Joined, not compared as an array: vitest truncates a long array diff to its
    // length, and the whole point of the failure is the list of places to fix.
    expect(
      offenses.join("\n"),
      `${offenses.length} raw NUL byte(s); git treats each file as binary — use "\\0" (or "\\x00" before a digit)`,
    ).toBe("");
  });
});
