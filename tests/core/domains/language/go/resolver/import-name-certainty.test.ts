import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { resolveGoFiles } from "../__helpers__/go-corpus.js";
import type { CallContext, ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { goImportNamedBy } from "../../../../../../src/core/domains/language/go/resolver/strategies/index.js";
import { extractFromGoFile } from "../../../../../../src/core/domains/language/go/walker/walker.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx, F3-3 — two imports of one file can both claim a
 * qualifier: an unaliased `"k8s.io/api/core/v1"` is ASSUMED to bind `core`
 * (the `/vN` element dropped) while its package clause really says `v1`, and
 * `"example.com/proj/core"` binds `core` for certain. Which one the qualifier
 * names was decided by IMPORT ORDER — the first import that claimed it won — so
 * listing the k8s import first sent `core.New()` to k8s and a recorded
 * `*core.Engine` result to the k8s path, and both went unresolved.
 *
 * A claim is ranked by how certain it is, never by where the import sits: an
 * alias, then the imported package's own `package` clause (the resolver reads
 * a project package's off disk; the walker cannot), then the path's last
 * element taken verbatim, then a name DERIVED from the path (`/vN` dropped,
 * `go-` stripped, cut at a character no identifier holds). Two imports tied at
 * the best rank bind that name to neither.
 */

const CORE = [
  "package core",
  "",
  "type Engine struct{}",
  "",
  "func New() *Engine { return &Engine{} }",
  "",
  "func (e *Engine) Run() {}",
  "",
].join("\n");

/** The re-validator's corpus `f3b`. */
const F3B = {
  "go.mod": "module example.com/proj\n\ngo 1.22\n",
  "core/core.go": CORE,
  "app/app.go": [
    "package app",
    "",
    "import (",
    '\t"k8s.io/api/core/v1"',
    '\t"example.com/proj/core"',
    ")",
    "",
    "// Y1: v1 binds the k8s package (real name v1); core binds the PROJECT package.",
    "func y1(p *v1.Pod) {",
    "\te := core.New()",
    "\te.Run()",
    "\tcore.New().Run()",
    "}",
    "",
  ].join("\n"),
  "app/app2.go": [
    "package app",
    "",
    "import (",
    '\t"example.com/proj/core"',
    '\t"k8s.io/api/core/v1"',
    ")",
    "",
    "// Y2: same imports, project import listed FIRST.",
    "func y2(p *v1.Pod) {",
    "\te := core.New()",
    "\te.Run()",
    "}",
    "",
  ].join("\n"),
  "app/app3.go": [
    "package app",
    "",
    "import (",
    '\t"k8s.io/api/core/v1"',
    '\t"example.com/proj/core"',
    ")",
    "",
    "// Y3: a RECORDED result type qualified by the project package, k8s import listed first.",
    "func mkE(p *v1.Pod) *core.Engine { return nil }",
    "",
    "func y3() {",
    "\te := mkE(nil)",
    "\te.Run()",
    "}",
    "",
  ].join("\n"),
};

describe("a qualifier two imports claim resolves by certainty, not import order (f3b)", () => {
  it("`core.New()` names the project package even when the k8s `/v1` import is listed first", () => {
    const sites = resolveGoFiles(F3B);
    expect(sites.get("app/app.go:10 core.New")).toBe("New @ core/core.go");
    expect(sites.get("app/app.go:11 e.Run")).toBe("Engine#Run @ core/core.go");
    expect(sites.get("app/app.go:12 core.New")).toBe("New @ core/core.go");
  });

  it("control: the project import listed first resolves the same way", () => {
    const sites = resolveGoFiles(F3B);
    expect(sites.get("app/app2.go:10 core.New")).toBe("New @ core/core.go");
    expect(sites.get("app/app2.go:11 e.Run")).toBe("Engine#Run @ core/core.go");
  });

  it("a recorded `*core.Engine` result is the project package's, whatever the import order", () => {
    expect(resolveGoFiles(F3B).get("app/app3.go:13 e.Run")).toBe("Engine#Run @ core/core.go");
  });
});

function recordedReturnTypes(lines: string[]): Record<string, string> | undefined {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  return extractFromGoFile({ tree: parser.parse(src), code: src, relPath: "app/app.go", language: "go", chunks: [] })
    .functionReturnTypes;
}

describe("the walker's recorded result types rank an import's names by certainty", () => {
  it("a verbatim last element outranks a name derived from another import's path, in either order", () => {
    for (const imports of [
      ['\t"k8s.io/api/core/v1"', '\t"example.com/proj/core"'],
      ['\t"example.com/proj/core"', '\t"k8s.io/api/core/v1"'],
    ]) {
      const types = recordedReturnTypes([
        "package app",
        "import (",
        ...imports,
        ")",
        "func mkE() *core.Engine { return nil }",
        "func mkPod() *v1.Pod { return nil }",
      ]);
      expect(types?.mkE).toBe("example.com/proj/core.Engine");
      expect(types?.mkPod).toBe("k8s.io/api/core/v1.Pod");
    }
  });

  it("an alias outranks every name read off a path", () => {
    const types = recordedReturnTypes([
      "package app",
      'import (\n\t"example.com/proj/core"\n\tcore "example.com/other/engine"\n)',
      "func mkE() *core.Engine { return nil }",
    ]);
    expect(types?.mkE).toBe("example.com/other/engine.Engine");
  });

  it("NEGATIVE: two imports tied at the best rank record nothing for that name", () => {
    const types = recordedReturnTypes([
      "package app",
      'import (\n\t"example.com/a/v1"\n\t"example.com/b/v1"\n\t"k8s.io/api/core/v1"\n\t"example.com/x/core/v2"\n)',
      "func mkV() *v1.Pod { return nil }",
      "func mkC() *core.Engine { return nil }",
    ]);
    expect(types?.mkV).toBeUndefined();
    expect(types?.mkC).toBeUndefined();
  });
});

describe("goImportNamedBy ranks an import's names by certainty", () => {
  const cfg = { composer: new DefaultSymbolIdComposer(), mode: "strict" as const };
  const plain = (importText: string): ImportRef => ({ importText, startLine: 1 });
  const ctxOf = (imports: ImportRef[]): CallContext => ({
    callerFile: "app/app.go",
    callerScope: [],
    imports,
    symbolTable: new InMemoryGlobalSymbolTable(),
  });

  it("a verbatim last element outranks a derived name, in either import order", () => {
    const k8s = plain("k8s.io/api/core/v1");
    const core = plain("example.com/proj/core");
    for (const imports of [
      [k8s, core],
      [core, k8s],
    ]) {
      expect(goImportNamedBy(cfg, "core", ctxOf(imports))).toBe(core);
      expect(goImportNamedBy(cfg, "v1", ctxOf(imports))).toBe(k8s);
    }
  });

  it("an alias outranks a verbatim last element", () => {
    const aliased: ImportRef = { ...plain("example.com/other/engine"), importedNames: ["core"] };
    expect(goImportNamedBy(cfg, "core", ctxOf([plain("example.com/proj/core"), aliased]))).toBe(aliased);
  });

  it("NEGATIVE: a name two imports claim at the same best rank binds neither", () => {
    expect(goImportNamedBy(cfg, "core", ctxOf([plain("example.com/a/core"), plain("example.com/b/core")]))).toBe(
      undefined,
    );
    expect(goImportNamedBy(cfg, "core", ctxOf([plain("k8s.io/api/core/v1"), plain("example.com/x/core/v2")]))).toBe(
      undefined,
    );
  });
});
