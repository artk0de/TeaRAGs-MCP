import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type ImportRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/python/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/caller.py",
  callerScope: [],
  imports: [],
  ...over,
});

const importOf = (importText: string, ...names: string[]): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: names,
  importedBindings: Object.fromEntries(names.map((n) => [n, n])),
});

/**
 * bd tea-rags-mcp-lbtmm — DEFECT 1. `self.<field>.<member>()` where the field's
 * type is KNOWN but is not a project class used to emit
 * `{ targetRelPath: "<Type>", targetSymbolId: "<Type>#<member>" }`: a target
 * whose file half is a TYPE NAME, not a file. Measured on the five Python
 * corpora, 184 such rows, none of them a match.
 */
describe("PythonSelfFieldSymbolResolutionStrategy — external field type", () => {
  const strat = new PythonSelfFieldSymbolResolutionStrategy(cfg);

  it("DROPS when the field's type is bound by an EXTERNAL import — no synthetic anchor", () => {
    const call: CallRef = {
      callText: "self._pattern.search(text)",
      receiver: "self._pattern",
      member: "search",
      startLine: 9,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: tableWith(),
        callerFile: "app/routing.py",
        callerScope: ["Rule"],
        imports: [importOf("re", "Pattern")],
        classFieldTypes: { Rule: { _pattern: "Pattern" } },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the field's type is a BUILTIN (`self.items: dict`)", () => {
    const call: CallRef = { callText: "self.items.get('enum')", receiver: "self.items", member: "get", startLine: 4 };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: tableWith(),
        callerFile: "app/jsonschema.py",
        callerScope: ["Schema"],
        classFieldTypes: { Schema: { items: "dict" } },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS on a QUALIFIED external type whose ROOT segment is the import binding (`io.BytesIO`)", () => {
    const call: CallRef = { callText: "self._buffer.tell()", receiver: "self._buffer", member: "tell", startLine: 7 };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: tableWith(),
        callerFile: "app/decoders.py",
        callerScope: ["Decoder"],
        imports: [importOf("io", "io")],
        classFieldTypes: { Decoder: { _buffer: "io.BytesIO" } },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("CONTINUEs when the type is UNKNOWN — no import binds it and no project class declares it", () => {
    const call: CallRef = {
      callText: "self.service.inherited()",
      receiver: "self.service",
      member: "inherited",
      startLine: 8,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: tableWith(),
        callerFile: "app/handler.py",
        callerScope: ["Handler"],
        classFieldTypes: { Handler: { service: "SomeService" } },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("never emits a target whose relPath is not a file, on either verdict", () => {
    const cases: [string, Partial<CallContext>][] = [
      ["Pattern", { imports: [importOf("re", "Pattern")], classFieldTypes: { Rule: { f: "Pattern" } } }],
      ["SomeService", { classFieldTypes: { Rule: { f: "SomeService" } } }],
    ];
    for (const [, over] of cases) {
      const outcome = strat.attempt(
        { callText: "self.f.go()", receiver: "self.f", member: "go", startLine: 3 },
        ctx({ symbolTable: tableWith(), callerScope: ["Rule"], ...over }),
      );
      expect(outcome.kind).not.toBe("resolved");
    }
  });

  it("still resolves to the project class when the field type IS in the table", () => {
    const outcome = strat.attempt(
      { callText: "self.service.process()", receiver: "self.service", member: "process", startLine: 8 },
      ctx({
        symbolTable: tableWith(["service.py", [sym("SomeService#process", "process", "service.py", ["SomeService"])]]),
        callerScope: ["Handler"],
        classFieldTypes: { Handler: { service: "SomeService" } },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "service.py", targetSymbolId: "SomeService#process" },
    });
  });
});

/**
 * bd tea-rags-mcp-lbtmm — DEFECT 2. `resolveTypeFile`'s first pass accepted ANY
 * sole short-name match as the bound type's file. polar's
 * `server/polar/backoffice/formatters.py` declares `def datetime(value)`, so
 * every `x: datetime` receiver in a file that did `from datetime import
 * datetime` landed there.
 */
describe("PythonLocalBindingSymbolResolutionStrategy — external / non-class bound type", () => {
  const strat = new PythonLocalBindingSymbolResolutionStrategy(cfg);

  it("does NOT resolve `start.astimezone()` onto a project `def datetime` namesake", () => {
    const symbolTable = tableWith([
      "server/polar/backoffice/formatters.py",
      [sym("datetime", "datetime", "server/polar/backoffice/formatters.py", [])],
    ]);
    const outcome = strat.attempt(
      { callText: "start.astimezone(UTC)", receiver: "start", member: "astimezone", startLine: 628 },
      ctx({
        symbolTable,
        callerFile: "server/polar/integrations/tinybird/service.py",
        imports: [importOf("datetime", "datetime")],
        localBindings: { start: [{ line: 628, type: "datetime" }] },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS a type bound by an external import even when NO namesake exists", () => {
    const outcome = strat.attempt(
      { callText: "table.add_column(style='dim')", receiver: "table", member: "add_column", startLine: 202 },
      ctx({
        symbolTable: tableWith(),
        callerFile: "dev/cli/cli.py",
        imports: [importOf("rich.table", "Table")],
        localBindings: { table: [{ line: 202, type: "Table" }] },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("refuses a sole short-name match that is a plain `def` — a function cannot own the member", () => {
    const symbolTable = tableWith(["app/util.py", [sym("helper", "helper", "app/util.py", [])]]);
    const outcome = strat.attempt(
      { callText: "h.run()", receiver: "h", member: "run", startLine: 5 },
      ctx({ symbolTable, localBindings: { h: [{ line: 5, type: "helper" }] } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  // xasyu: was "keeps the file-only edge when the bound type DECLARES a base
  // class", asserting `{ kind: "resolved", target: { reaction.py, null } }`.
  // The declared base still proves class-kind to the lbtmm probe; what changed
  // is the answer on a member the class does not own — a file with no symbol
  // is not an answer a call site can carry.
  it("DROPS when the bound type DECLARES a base class but the member is external (real class, external member)", () => {
    const symbolTable = tableWith([
      "reaction.py",
      [sym("ToggleReactionSerializer", "ToggleReactionSerializer", "reaction.py", [])],
    ]);
    const outcome = strat.attempt(
      { callText: "serializer.is_valid()", receiver: "serializer", member: "is_valid", startLine: 1 },
      ctx({
        symbolTable,
        classExtends: { ToggleReactionSerializer: "serializers.ModelSerializer" },
        localBindings: { serializer: [{ line: 1, type: "ToggleReactionSerializer" }] },
      }),
    );
    expect(outcome).toEqual({ kind: "drop" });
  });

  it("keeps the pinned edge when the type OWNS the member (class-kind proven by the member probe)", () => {
    const symbolTable = tableWith([
      "toggle.py",
      [
        sym("ToggleReactionService", "ToggleReactionService", "toggle.py", []),
        sym("ToggleReactionService#execute", "execute", "toggle.py", ["ToggleReactionService"]),
      ],
    ]);
    const outcome = strat.attempt(
      { callText: "service.execute()", receiver: "service", member: "execute", startLine: 1 },
      ctx({ symbolTable, localBindings: { service: [{ line: 1, type: "ToggleReactionService" }] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "toggle.py", targetSymbolId: "ToggleReactionService#execute" },
    });
  });
});
