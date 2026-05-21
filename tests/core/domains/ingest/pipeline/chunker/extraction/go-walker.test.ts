import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { extractFromGoFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/go-walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang as unknown as Parser.Language);
  return p.parse(src);
}

describe("extractFromGoFile — imports", () => {
  it('captures single-line `import "foo/bar"`', () => {
    const src = 'package main\nimport "foo/bar"\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "main.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo/bar"]);
  });

  it('captures grouped `import ( "a"; "b/c" )`', () => {
    const src = 'package main\nimport (\n  "a"\n  "b/c"\n)\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "main.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["a", "b/c"]);
  });

  it("captures import with alias (the path, alias dropped)", () => {
    const src = 'package main\nimport alias "foo/bar"\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "main.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo/bar"]);
  });

  it("records startLine per import", () => {
    const src = 'package main\nimport (\n  "a"\n  "b"\n)\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "x.go", language: "go", chunks: [] });
    const lines = r.imports.map((i) => i.startLine).sort();
    expect(lines).toEqual([3, 4]);
  });
});

describe("extractFromGoFile — calls", () => {
  it("captures `pkg.Func()`", () => {
    const src = "package main\nfunc main() { pkg.Func() }\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "main.go",
      language: "go",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 2 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("pkg");
    expect(c.member).toBe("Func");
  });

  it("captures bare calls", () => {
    // Avoid `go` — Go keyword for goroutines, not a function call.
    const src = "package main\nfunc main() { run() }\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "main.go",
      language: "go",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 2 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBeNull();
    expect(c.member).toBe("run");
  });
});

describe("extractFromGoFile — edge cases", () => {
  it("empty file returns empty extraction", () => {
    const r = extractFromGoFile({ tree: parse(""), code: "", relPath: "x.go", language: "go", chunks: [] });
    expect(r.imports).toEqual([]);
  });

  it("ignores comments", () => {
    const src = 'package main\n// import "fake"\nimport "real"\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "x.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["real"]);
  });
});

// Selector-expression vs identifier call dispatch — coexisting in one
// body so the per-node branch in collectGoCalls is exercised twice.
describe("extractFromGoFile — call dispatch", () => {
  it("captures `pkg.Func()` alongside bare `helper()` in same body", () => {
    const src = "package main\nfunc main() {\n  pkg.Func()\n  helper()\n}\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "main.go",
      language: "go",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 5 }],
    });
    const pkgFunc = r.chunks[0].calls.find((c) => c.member === "Func");
    const helper = r.chunks[0].calls.find((c) => c.member === "helper");
    expect(pkgFunc?.receiver).toBe("pkg");
    expect(helper?.receiver).toBeNull();
  });
});
