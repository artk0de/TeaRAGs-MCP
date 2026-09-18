import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * A bare call through a LOCAL — gin's `handle(c, rec)`, `handle` being
 * `CustomRecoveryWithWriter`'s func-typed parameter — calls a function VALUE,
 * whose target nothing static knows. The shared miss classifier counted it as
 * `missWithInProjectDef` because some type declares a `handle` METHOD, which a
 * bare Go call can never reach. The walker tags such a call `dynamicSend`, the
 * one CallRef fact the classifier reads as statically undeterminable
 * (`unresolvable`, out of the recall denominator) — stats only: no pass
 * resolves it either way.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function walk(lines: string[]) {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const go = new GoLanguage();
  const extraction = go.walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath: "recovery.go",
    language: "go",
    chunks: [{ symbolId: "f", scope: [], startLine: 2, endLine: lines.length }],
  });
  return { go, extraction, chunk: extraction.chunks[0] };
}

const bareCall = (calls: readonly CallRef[], member: string, line?: number): CallRef | undefined =>
  calls.find((c) => c.receiver === null && c.member === member && (line === undefined || c.startLine === line));

describe("Go walker — bare calls through a function value", () => {
  it("tags a call through a func-typed parameter (gin recovery.go shape)", () => {
    const { chunk } = walk([
      "package gin",
      "func CustomRecoveryWithWriter(out io.Writer, handle RecoveryFunc) HandlerFunc {",
      "\treturn func(c *Context) {",
      "\t\thandle(c, nil)",
      "\t}",
      "}",
    ]);
    expect(bareCall(chunk.calls, "handle")?.dynamicSend).toBe(true);
  });

  it("tags a call through a local assigned a function literal, only once it is in scope", () => {
    const { chunk } = walk(["package gin", "func f() {", "\thelper()", "\thelper := func() {}", "\thelper()", "}"]);
    expect(bareCall(chunk.calls, "helper", 3)?.dynamicSend).toBeUndefined();
    expect(bareCall(chunk.calls, "helper", 5)?.dynamicSend).toBe(true);
  });

  it("leaves a bare call of a package-level function untagged", () => {
    const { chunk } = walk(["package gin", "func f() {", "\tNew()", "}"]);
    expect(bareCall(chunk.calls, "New")?.dynamicSend).toBeUndefined();
  });

  it("classifies the unresolved func-value call as unresolvable, not an in-project miss", () => {
    const { go, extraction, chunk } = walk([
      "package gin",
      "func CustomRecoveryWithWriter(out io.Writer, handle RecoveryFunc) HandlerFunc {",
      "\treturn func(c *Context) {",
      "\t\thandle(c, nil)",
      "\t}",
      "}",
    ]);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("tree.go", [sym("methodTree", "tree.go"), sym("methodTree#handle", "tree.go")]);
    const call = bareCall(chunk.calls, "handle");
    if (!call) throw new Error("walker emitted no handle(...) call");
    const ctx: CallContext = {
      callerFile: "recovery.go",
      callerScope: [],
      imports: extraction.imports,
      symbolTable: table,
      localBindings: chunk.localBindings,
      callResultBindings: chunk.callResultBindings,
    };
    expect(go.resolver.resolve(call, ctx)).toBeNull();
    expect(classifyResolveMiss(call, ctx, go.resolver, table)).toBe("unresolvable");
  });
});
