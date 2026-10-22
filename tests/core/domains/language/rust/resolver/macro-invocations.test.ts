/**
 * Rust macro invocations live in the macro namespace (bd tea-rags-mcp-s3i8m.2).
 * `format!` can never resolve to `fn format`, and `helper()` can never resolve
 * to `macro_rules! helper`. A macro invocation resolves only against macro
 * definitions, scoped the way Rust scopes them as far as the symbol table can
 * tell: textual scope inside the caller's file (definition before the call,
 * latest definition shadows), then the caller's crate, else a sole project
 * definition reached through a `use` binding or a crate-qualified path. Where
 * several definitions share the name and the scope cannot pick one, the call
 * declines instead of guessing.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

interface DefSpec {
  relPath: string;
  name: string;
  kind: SymbolDefinitionKind;
  startLine?: number;
  scope?: string[];
}

function table(defs: DefSpec[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, DefSpec[]>();
  for (const d of defs) byFile.set(d.relPath, [...(byFile.get(d.relPath) ?? []), d]);
  for (const [relPath, specs] of byFile) {
    t.upsertFile(
      relPath,
      specs.map((d) => {
        const scope = d.scope ?? [];
        const symbolId = [...scope, d.name].join("::");
        return {
          symbolId,
          fqName: symbolId,
          shortName: d.name,
          relPath,
          scope,
          symbolKind: d.kind,
          ...(d.startLine !== undefined ? { startLine: d.startLine, endLine: d.startLine + 2 } : {}),
        };
      }),
    );
  }
  return t;
}

function ctx(
  callerFile: string,
  t: InMemoryGlobalSymbolTable,
  imports: { importText: string; startLine: number }[] = [],
  callerScope: string[] = [],
): CallContext {
  return { callerFile, callerScope, imports, symbolTable: t };
}

function macroCall(member: string, startLine: number, receiver: string | null = null): CallRef {
  const path = receiver === null ? member : `${receiver}::${member}`;
  return { callText: `${path}!(x)`, receiver, member, startLine };
}

describe("Rust macro invocations — external classification in the macro namespace", () => {
  it("classifies a std macro external even when the project declares a fn of that name", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/fmt.rs", name: "format", kind: "function" }]);
    expect(r.targetsExternalImport?.(macroCall("format", 9), ctx("src/main.rs", t))).toBe(true);
  });

  it("keeps a std macro name in the denominator when the project declares a macro of that name", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/macros.rs", name: "format", kind: "macro" }]);
    expect(r.targetsExternalImport?.(macroCall("format", 9), ctx("src/main.rs", t))).toBe(false);
  });

  it("classifies a std-path macro invocation external", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/out.rs", name: "println", kind: "function" }]);
    expect(r.targetsExternalImport?.(macroCall("println", 3, "std"), ctx("src/main.rs", t))).toBe(true);
  });

  it("classifies an external-crate macro path external", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/walk.rs", name: "debug", kind: "function" }]);
    expect(r.targetsExternalImport?.(macroCall("debug", 3, "log"), ctx("src/main.rs", t))).toBe(true);
  });

  it("keeps a macro path through a project module in the denominator", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/macros.rs", name: "emit", kind: "macro" }]);
    expect(r.targetsExternalImport?.(macroCall("emit", 3, "macros"), ctx("src/main.rs", t))).toBe(false);
  });

  it("answers hasInProjectDefinition for a macro invocation from macro definitions only", () => {
    const r = new RustCallResolver();
    const fnOnly = table([{ relPath: "src/lib.rs", name: "matches", kind: "function" }]);
    const macro = table([{ relPath: "src/lib.rs", name: "matches", kind: "macro" }]);
    expect(r.hasInProjectDefinition?.(macroCall("matches", 4), ctx("src/main.rs", fnOnly))).toBe(false);
    expect(r.hasInProjectDefinition?.(macroCall("matches", 4), ctx("src/main.rs", macro))).toBe(true);
  });

  it("never counts a macro definition as the in-project definition of a plain call", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/lib.rs", name: "helper", kind: "macro" }]);
    const call = { callText: "helper(x)", receiver: null, member: "helper", startLine: 4 };
    expect(r.hasInProjectDefinition?.(call, ctx("src/main.rs", t))).toBe(false);
  });
});

describe("Rust macro invocations — resolution in the macro namespace", () => {
  it("resolves to the same-file macro defined before the call, never to a same-named fn", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "src/util.rs", name: "emit", kind: "function", startLine: 1 },
      { relPath: "src/main.rs", name: "emit", kind: "macro", startLine: 5 },
    ]);
    expect(r.resolve(macroCall("emit", 12), ctx("src/main.rs", t))).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "emit",
    });
  });

  it("does not resolve a macro invocation to a fn when no macro of that name exists", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/util.rs", name: "matches", kind: "function", startLine: 1 }]);
    expect(r.resolve(macroCall("matches", 12), ctx("src/main.rs", t))).toBeNull();
  });

  it("picks the latest same-file definition before the call (textual shadowing)", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "src/main.rs", name: "emit", kind: "macro", startLine: 1, scope: [] },
      { relPath: "src/main.rs", name: "emit", kind: "macro", startLine: 20, scope: ["inner"] },
    ]);
    expect(r.resolve(macroCall("emit", 10), ctx("src/main.rs", t))?.targetSymbolId).toBe("emit");
    expect(r.resolve(macroCall("emit", 30), ctx("src/main.rs", t, [], ["inner"]))?.targetSymbolId).toBe("inner::emit");
  });

  it("does not see a same-file definition from a sibling module", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "src/main.rs", name: "emit", kind: "macro", startLine: 1, scope: ["a"] },
      { relPath: "src/main.rs", name: "emit", kind: "macro", startLine: 9, scope: ["b"] },
    ]);
    expect(r.resolve(macroCall("emit", 30), ctx("src/main.rs", t, [], ["c"]))).toBeNull();
  });

  it("declines a same-file definition that follows the call", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/main.rs", name: "emit", kind: "macro", startLine: 40 }]);
    expect(r.resolve(macroCall("emit", 10), ctx("src/main.rs", t))).toBeNull();
  });

  it("resolves to the sole macro of the caller's crate over another crate's namesake", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "crates/printer/src/macros.rs", name: "assert_eq_printed", kind: "macro", startLine: 1 },
      { relPath: "crates/searcher/src/testutil.rs", name: "assert_eq_printed", kind: "macro", startLine: 1 },
    ]);
    expect(r.resolve(macroCall("assert_eq_printed", 300), ctx("crates/printer/src/standard.rs", t))).toEqual({
      targetRelPath: "crates/printer/src/macros.rs",
      targetSymbolId: "assert_eq_printed",
    });
  });

  it("declines when several macros of the caller's crate share the name", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "crates/printer/src/a.rs", name: "find", kind: "macro", startLine: 1 },
      { relPath: "crates/printer/src/b.rs", name: "find", kind: "macro", startLine: 1 },
    ]);
    expect(r.resolve(macroCall("find", 30), ctx("crates/printer/src/standard.rs", t))).toBeNull();
  });

  it("declines a bare macro defined only in another crate and not imported", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "crates/searcher/src/testutil.rs", name: "ext", kind: "macro", startLine: 1 }]);
    expect(r.resolve(macroCall("ext", 30), ctx("crates/printer/src/standard.rs", t))).toBeNull();
  });

  it("resolves a bare macro bound by a project `use` to the sole project definition", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "crates/matcher/src/lib.rs", name: "ext", kind: "macro", startLine: 1 }]);
    const c = ctx("crates/printer/src/standard.rs", t, [{ importText: "matcher::ext", startLine: 2 }]);
    expect(r.resolve(macroCall("ext", 30), c)?.targetRelPath).toBe("crates/matcher/src/lib.rs");
  });

  it("resolves a crate-qualified macro path within the caller's crate", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "crates/printer/src/macros.rs", name: "emit", kind: "macro", startLine: 1 },
      { relPath: "crates/other/src/macros.rs", name: "emit", kind: "macro", startLine: 1 },
    ]);
    expect(r.resolve(macroCall("emit", 30, "crate"), ctx("crates/printer/src/standard.rs", t))?.targetRelPath).toBe(
      "crates/printer/src/macros.rs",
    );
  });

  it("resolves a module-level invocation inside the module that defines the macro", () => {
    // `mod tests { macro_rules! toregex {…} toregex!(case, …); }` — the call
    // site's chunk IS the `tests` module, whose declaration scope is `[]`.
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/glob.rs", name: "toregex", kind: "macro", startLine: 10, scope: ["tests"] }]);
    const c = { ...ctx("src/glob.rs", t), callerSymbolId: "tests" };
    expect(r.resolve(macroCall("toregex", 40), c)?.targetSymbolId).toBe("tests::toregex");
  });

  it("scopes the crate by its crate-root file, not by the caller's directory", () => {
    const r = new RustCallResolver();
    const t = table([
      { relPath: "crates/core/main.rs", name: "main", kind: "function", startLine: 1 },
      { relPath: "crates/core/messages.rs", name: "message", kind: "macro", startLine: 70 },
    ]);
    expect(r.resolve(macroCall("message", 35), ctx("crates/core/flags/config.rs", t))?.targetRelPath).toBe(
      "crates/core/messages.rs",
    );
  });

  it("declines a std macro name whose only project namesake lives in another file", () => {
    // `writeln!` in main.rs is std's; man.rs's local `macro_rules! writeln`
    // reaches it only through a `#[macro_use]` the table cannot see.
    const r = new RustCallResolver();
    const t = table([
      { relPath: "crates/core/main.rs", name: "main", kind: "function", startLine: 1 },
      { relPath: "crates/core/flags/doc/man.rs", name: "writeln", kind: "macro", startLine: 21 },
    ]);
    expect(r.resolve(macroCall("writeln", 367), ctx("crates/core/main.rs", t))).toBeNull();
  });

  it("declines a std-path macro invocation", () => {
    const r = new RustCallResolver();
    const t = table([{ relPath: "src/main.rs", name: "println", kind: "macro", startLine: 1 }]);
    expect(r.resolve(macroCall("println", 30, "std"), ctx("src/main.rs", t))).toBeNull();
  });
});

describe("Rust macro invocations — walked end to end", () => {
  function edges(files: Record<string, string>, callerFile: string) {
    const language = new RustLanguage();
    const factory = new LanguageFactory();
    const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
    const symbolTable = new InMemoryGlobalSymbolTable();
    const extractions: FileExtraction[] = [];
    for (const [relPath, code] of Object.entries(files)) {
      const parser = new Parser();
      parser.setLanguage(RustLang);
      const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
      const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
      const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
      symbolTable.upsertFile(
        relPath,
        extraction.chunks.map((chunk) => ({
          ...chunk,
          fqName: chunk.symbolId,
          shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
          relPath,
        })),
      );
      extractions.push(extraction);
      runState.absorb(extraction, []);
    }
    const extraction = extractions.find((entry) => entry.relPath === callerFile)!;
    return new CallEdgeResolutionRunner(factory, runState)
      .resolve(extraction, symbolTable)
      .methodEdges.map((edge) => `${edge.sourceSymbolId}->${edge.targetRelPath}:${edge.targetSymbolId}`);
  }

  it("never resolves a plain call to a macro_rules! definition of the same name", () => {
    const found = edges(
      {
        "src/macros.rs": "macro_rules! helper { () => {} }\n",
        "src/main.rs": "fn run() {\n    helper();\n}\n",
      },
      "src/main.rs",
    );
    expect(found).toEqual([]);
  });

  it("links a macro invocation to its macro_rules! definition, not to the same-named fn", () => {
    const found = edges(
      {
        "src/util.rs": "pub fn emit() {}\n",
        "src/macros.rs": "macro_rules! emit { () => {} }\n",
        "src/main.rs": ["fn run() {", "    emit!();", "    emit();", "}"].join("\n"),
      },
      "src/main.rs",
    );
    expect(found.sort()).toEqual(["run->src/macros.rs:emit", "run->src/util.rs:emit"]);
  });
});
