import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { goLocalBindingAt } from "../../../../../../src/core/domains/language/go/local-scope.js";
import { extractFromGoFile } from "../../../../../../src/core/domains/language/go/walker/walker.js";

/**
 * bd tea-rags-mcp-e6xx — the walker records each local against the block that
 * declares it, and `goLocalBindingAt` reads it with Go's scope rule: a local a
 * statement declares is in scope after that statement, up to the end of its
 * innermost block. Read through the Go lookup, which is what the resolver
 * reads.
 */

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang);
  return p.parse(src);
}

function bindingsOf(lines: string[]): Record<string, LocalBinding[]> | undefined {
  const src = `${lines.join("\n")}\n`;
  const start = lines.findIndex((line) => line.startsWith("func ")) + 1;
  const r = extractFromGoFile({
    tree: parse(src),
    code: src,
    relPath: "app/app.go",
    language: "go",
    chunks: [{ symbolId: "f", scope: [], startLine: start, endLine: lines.length }],
  });
  return r.chunks[0].localBindings;
}

describe("Go walker — block-scoped local bindings", () => {
  it("a typed local declared in a nested block does not outlive it", () => {
    const bindings = bindingsOf([
      "package app",
      "func f(e *Plugin) {",
      "\tif ok {",
      "\t\tvar e Engine",
      "\t\te.Use()",
      "\t}",
      "\te.Use()",
      "}",
    ]);
    expect(goLocalBindingAt(bindings, "e", 5)?.type).toBe("Engine");
    expect(goLocalBindingAt(bindings, "e", 7)?.type).toBe("Plugin");
  });

  it("binds every name of a multi-name parameter", () => {
    const bindings = bindingsOf(["package app", "func f(a, b *Engine) {", "\tb.Use()", "}"]);
    expect(goLocalBindingAt(bindings, "a", 3)?.type).toBe("Engine");
    expect(goLocalBindingAt(bindings, "b", 3)?.type).toBe("Engine");
  });

  it("binds every name of a grouped `var ( … )` declaration", () => {
    const bindings = bindingsOf(["package app", "func f() {", "\tvar (", "\t\te Engine", "\t)", "\te.Use()", "}"]);
    expect(goLocalBindingAt(bindings, "e", 6)?.type).toBe("Engine");
  });

  it("a shadow of an import name is out of scope on its own statement's lines", () => {
    const bindings = bindingsOf([
      "package app",
      'import "app/config"',
      "func f() {",
      "\tconfig, err := config.Load(",
      "\t\tconfig.Default(),",
      "\t)",
      "\tconfig.Validate()",
      "\t_ = err",
      "}",
    ]);
    expect(goLocalBindingAt(bindings, "config", 4)).toBeUndefined();
    expect(goLocalBindingAt(bindings, "config", 5)).toBeUndefined();
    expect(goLocalBindingAt(bindings, "config", 7)).toEqual({ line: 4, type: "", endLine: 6 });
  });

  it("positions a call binding at its statement and scopes it to its block", () => {
    const src = [
      "package app",
      "func f(ok bool) {",
      "\tif ok {",
      "\t\te := New(",
      "\t\t\t1,",
      "\t\t)",
      "\t\te.Use()",
      "\t}",
      "}",
    ];
    const text = `${src.join("\n")}\n`;
    const r = extractFromGoFile({
      tree: parse(text),
      code: text,
      relPath: "app/app.go",
      language: "go",
      chunks: [{ symbolId: "f", scope: [], startLine: 2, endLine: src.length }],
    });
    // No `endLine`: the right-hand side does not name `e`, so the binding is
    // visible from its own line (a header's `if e := New(); e.Ok()` reads it).
    expect(r.chunks[0].callResultBindings?.e).toEqual([{ line: 4, callee: "New", scopeEndLine: 8 }]);
    expect(r.chunks[0].localCallBindings).toBeUndefined();
  });

  it("records no call binding a var↔return pairing cannot back", () => {
    const src = [
      "package app",
      "func f() {",
      "\ta, b := New(), Other()",
      "\tx := New().Configure()",
      "\t_, _, _ = a, b, x",
      "}",
    ];
    const text = `${src.join("\n")}\n`;
    const r = extractFromGoFile({
      tree: parse(text),
      code: text,
      relPath: "app/app.go",
      language: "go",
      chunks: [{ symbolId: "f", scope: [], startLine: 2, endLine: src.length }],
    });
    expect(r.chunks[0].callResultBindings).toBeUndefined();
  });

  it("records no shadow for a local whose name no import binds", () => {
    const bindings = bindingsOf([
      "package app",
      'import "app/config"',
      "func f() {",
      "\tcfg, err := load()",
      "\t_, _ = cfg, err",
      "}",
    ]);
    expect(bindings?.cfg).toBeUndefined();
    expect(bindings?.err).toBeUndefined();
  });
});
