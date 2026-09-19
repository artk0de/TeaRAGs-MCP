import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { CallContext, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * A local or parameter that SHADOWS an imported package name is a value, not
 * the package: `config, err := loadTwo(); config.Validate()` calls a method on
 * whatever `loadTwo` returned, never the package function `config.Validate`.
 * The walker recorded no binding for these names — multi-assign left-hand
 * sides, range variables, untyped parameters, untyped function-literal
 * parameters — so `importMatch` read the receiver as the package and
 * fabricated the edge. A Go local is in scope only AFTER the statement that
 * declares it, so the right-hand side of that same statement still names the
 * package. Walker and resolver together, on source shaped after the
 * validate-B probe corpus.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function projectTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("app/config/config.go", [
    sym("Config", "app/config/config.go"),
    sym("Validate", "app/config/config.go"),
    sym("LoadTwo", "app/config/config.go"),
  ]);
  t.upsertFile("app/render/render.go", [sym("Write", "app/render/render.go")]);
  return t;
}

const HEADER = ["package app", "", "import (", '\t"io"', "", '\t"app/config"', '\t"app/render"', ")"];

/**
 * Resolve every call of the single function in `body` (its first line the
 * `func` line). Keys are `<line offset from the func line>:<receiver>.<member>`.
 */
function resolveAll(body: string[]): Map<string, string | null> {
  const lines = [...HEADER, ...body];
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const startLine = HEADER.length + 1;
  const go = new GoLanguage();
  const extraction = go.walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath: "app/app.go",
    language: "go",
    chunks: [{ symbolId: "f", scope: [], startLine, endLine: lines.length }],
  });
  const chunk = extraction.chunks[0];
  const ctx: CallContext = {
    callerFile: "app/app.go",
    callerScope: [],
    imports: extraction.imports,
    symbolTable: projectTable(),
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
  };
  const out = new Map<string, string | null>();
  for (const call of chunk.calls) {
    const target = go.resolver.resolve(call, ctx);
    out.set(
      `${call.startLine - startLine}:${call.receiver}.${call.member}`,
      target ? `${target.targetSymbolId} @ ${target.targetRelPath}` : null,
    );
  }
  return out;
}

describe("Go locals that shadow an imported package name", () => {
  it("NEGATIVE: a multi-assign local is not the package it shadows", () => {
    const resolved = resolveAll([
      "func f() error {",
      "\tconfig, err := loadTwo()",
      "\tconfig.Validate()",
      "\treturn err",
      "}",
    ]);
    expect(resolved.get("2:config.Validate")).toBeNull();
  });

  it("the right-hand side of the declaring statement still names the package", () => {
    const resolved = resolveAll([
      "func f() error {",
      "\tconfig, err := config.LoadTwo()",
      "\tconfig.Validate()",
      "\treturn err",
      "}",
    ]);
    expect(resolved.get("1:config.LoadTwo")).toBe("LoadTwo @ app/config/config.go");
    expect(resolved.get("2:config.Validate")).toBeNull();
  });

  it("NEGATIVE: an untyped parameter is not the package it shadows", () => {
    const resolved = resolveAll(["func f(render io.Writer) {", "\trender.Write(nil)", "}"]);
    expect(resolved.get("1:render.Write")).toBeNull();
  });

  it("NEGATIVE: every name of a multi-name parameter shadows", () => {
    const resolved = resolveAll(["func f(out, render io.Writer) {", "\trender.Write(nil)", "}"]);
    expect(resolved.get("1:render.Write")).toBeNull();
  });

  it("NEGATIVE: a named RESULT parameter is not the package it shadows", () => {
    const resolved = resolveAll(["func f() (render io.Writer) {", "\trender.Write(nil)", "\treturn", "}"]);
    expect(resolved.get("1:render.Write")).toBeNull();
  });

  it("NEGATIVE: a function literal's named result shadows for the literal's lines only", () => {
    const resolved = resolveAll([
      "func f() {",
      "\tg := func() (render io.Writer) {",
      "\t\trender.Write(nil)",
      "\t\treturn",
      "\t}",
      "\trender.Write(nil)",
      "\t_ = g",
      "}",
    ]);
    expect(resolved.get("2:render.Write")).toBeNull();
    expect(resolved.get("5:render.Write")).toBe("Write @ app/render/render.go");
  });

  it("NEGATIVE: an untyped function-literal parameter shadows for the literal's lines only", () => {
    const resolved = resolveAll([
      "func f() {",
      "\tg := func(render io.Writer) {",
      "\t\trender.Write(nil)",
      "\t}",
      "\trender.Write(nil)",
      "\t_ = g",
      "}",
    ]);
    expect(resolved.get("2:render.Write")).toBeNull();
    expect(resolved.get("4:render.Write")).toBe("Write @ app/render/render.go");
  });

  it("NEGATIVE: a range variable shadows inside its loop, and the package is back after it", () => {
    const resolved = resolveAll([
      "func f(rs []io.Writer) {",
      "\tfor _, render := range rs {",
      "\t\trender.Write(nil)",
      "\t}",
      "\trender.Write(nil)",
      "}",
    ]);
    expect(resolved.get("2:render.Write")).toBeNull();
    expect(resolved.get("4:render.Write")).toBe("Write @ app/render/render.go");
  });

  it("a call before the shadowing declaration still names the package", () => {
    const resolved = resolveAll([
      "func f() error {",
      "\tconfig.Validate()",
      "\tconfig, err := loadTwo()",
      "\t_ = config",
      "\treturn err",
      "}",
    ]);
    expect(resolved.get("1:config.Validate")).toBe("Validate @ app/config/config.go");
  });
});
