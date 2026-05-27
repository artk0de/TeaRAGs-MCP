import Parser from "tree-sitter";
import BashLang from "tree-sitter-bash";
import { describe, expect, it } from "vitest";

import { extractFromBashFile } from "../../../../../../src/core/domains/language/bash/walker/walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(BashLang as unknown as Parser.Language);
  return p.parse(src);
}

describe("extractFromBashFile — imports (source/.)", () => {
  it("captures `source ./other.sh`", () => {
    const src = "source ./other.sh\n";
    const r = extractFromBashFile({ tree: parse(src), code: src, relPath: "main.sh", language: "bash", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["./other.sh"]);
  });

  it("captures `. ./other.sh` (POSIX-style)", () => {
    const src = ". ./other.sh\n";
    const r = extractFromBashFile({ tree: parse(src), code: src, relPath: "main.sh", language: "bash", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["./other.sh"]);
  });

  it("captures multiple sources", () => {
    const src = "source ./a.sh\nsource ./b.sh\n";
    const r = extractFromBashFile({ tree: parse(src), code: src, relPath: "main.sh", language: "bash", chunks: [] });
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["./a.sh", "./b.sh"]);
  });

  it("does NOT capture other commands as imports", () => {
    const src = "echo foo\nls -la\n";
    const r = extractFromBashFile({ tree: parse(src), code: src, relPath: "main.sh", language: "bash", chunks: [] });
    expect(r.imports).toEqual([]);
  });
});

describe("extractFromBashFile — function calls (only internal)", () => {
  it("captures calls to functions defined in same file", () => {
    const src = "function go() { echo hi; }\nfunction main() { go; }\n";
    const r = extractFromBashFile({
      tree: parse(src),
      code: src,
      relPath: "x.sh",
      language: "bash",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 2 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c?.member).toBe("go");
  });

  it("does NOT capture external binary invocations", () => {
    // `cat`, `ls`, `echo` are external — adding them would drown the graph.
    const src = "function main() { cat /etc/hosts; ls -la; }\n";
    const r = extractFromBashFile({
      tree: parse(src),
      code: src,
      relPath: "x.sh",
      language: "bash",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 1 }],
    });
    expect(r.chunks[0].calls).toEqual([]);
  });
});

describe("extractFromBashFile — edge cases", () => {
  it("empty file returns empty extraction", () => {
    const r = extractFromBashFile({ tree: parse(""), code: "", relPath: "x.sh", language: "bash", chunks: [] });
    expect(r.imports).toEqual([]);
  });

  it("ignores comments", () => {
    const src = "# source ./fake.sh\nsource ./real.sh\n";
    const r = extractFromBashFile({ tree: parse(src), code: src, relPath: "x.sh", language: "bash", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["./real.sh"]);
  });
});

// Drives the `defined.has(name)` exclusion in collectBashFunctionCalls
// alongside the include path. We define `helper`, call BOTH `helper`
// (in-set) and `external_binary` (out-of-set) — the walker must emit
// the first and drop the second. This exercises both sides of the
// branch on line 86 of bash-walker.
describe("extractFromBashFile — defined-set call filtering", () => {
  it("emits in-set function calls and drops out-of-set command invocations", () => {
    const src = [
      "function helper() { echo h; }",
      "function main() {",
      "  helper",
      "  external_binary --flag",
      "}",
      "",
    ].join("\n");
    const r = extractFromBashFile({
      tree: parse(src),
      code: src,
      relPath: "x.sh",
      language: "bash",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 5 }],
    });
    const members = r.chunks[0].calls.map((c) => c.member);
    expect(members).toContain("helper");
    expect(members).not.toContain("external_binary");
  });

  it("captures multiple `source` lines mixed with `.` POSIX form", () => {
    // Three distinct import shapes in one file. Confirms the walker walks
    // every `command` node and applies the name === "source" || "." gate
    // at each — not just once.
    const src = "source ./a.sh\n. ./b.sh\nsource ./c.sh\n";
    const r = extractFromBashFile({ tree: parse(src), code: src, relPath: "main.sh", language: "bash", chunks: [] });
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["./a.sh", "./b.sh", "./c.sh"]);
    // startLine pins each to its actual line — verifies the row+1 conversion.
    expect(r.imports.map((i) => i.startLine).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("source with quoted path strips surrounding quotes", () => {
    // The walker strips matching leading/trailing `"` or `'` from the
    // argument literal so the importText is the bare path. Drives the
    // quote-strip regex branch.
    const srcDouble = 'source "./quoted.sh"\n';
    const r1 = extractFromBashFile({
      tree: parse(srcDouble),
      code: srcDouble,
      relPath: "main.sh",
      language: "bash",
      chunks: [],
    });
    expect(r1.imports.map((i) => i.importText)).toEqual(["./quoted.sh"]);
    const srcSingle = "source './single.sh'\n";
    const r2 = extractFromBashFile({
      tree: parse(srcSingle),
      code: srcSingle,
      relPath: "main.sh",
      language: "bash",
      chunks: [],
    });
    expect(r2.imports.map((i) => i.importText)).toEqual(["./single.sh"]);
  });
});
