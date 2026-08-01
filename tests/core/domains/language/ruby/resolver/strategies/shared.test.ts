import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type NamedSymbol,
  type SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  firstDefinerAfter,
  resolveSelfDispatchHookTarget,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// Mirrors the harness in strategies.test.ts.
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
  callerFile: "caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

describe("firstDefinerAfter — MRO after X (cai0/2oky5)", () => {
  it("finds the next definer after an INCLUDED module in C's ancestor chain", () => {
    // `class C; include Base; include M; end` — C.ancestors == [C, M, Base], so
    // `super` from M#m reaches Base#m. The walker stores that class body as
    // ["Base", "M"]: declaration order, in which the NEARER mixin comes last.
    const symbolTable = tableWith([
      "base.rb",
      [sym("Base", "Base", "base.rb", []), sym("Base#m", "m", "base.rb", ["Base"])],
    ]);
    const t = firstDefinerAfter(
      "M",
      "m",
      "C",
      ctx({ symbolTable, classAncestors: { C: ["Base", "M"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "base.rb", targetSymbolId: "Base#m" });
  });

  it("skips PAST a prepended module to the class itself (Wrapper → Agent)", () => {
    // Agent prepends Wrapper; Agent defines `save`. super from Wrapper#save → Agent#save.
    const symbolTable = tableWith([
      "agent.rb",
      [sym("Agent", "Agent", "agent.rb", []), sym("Agent#save", "save", "agent.rb", ["Agent"])],
    ]);
    const t = firstDefinerAfter(
      "Wrapper",
      "save",
      "Agent",
      ctx({ symbolTable, classPrependedAncestors: { Agent: ["Wrapper"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "agent.rb", targetSymbolId: "Agent#save" });
  });

  it("returns null when startAfter is not in klass's MRO", () => {
    const symbolTable = tableWith([
      "base.rb",
      [sym("Base", "Base", "base.rb", []), sym("Base#m", "m", "base.rb", ["Base"])],
    ]);
    expect(
      firstDefinerAfter(
        "NotInChain",
        "m",
        "C",
        ctx({ symbolTable, classAncestors: { C: ["Base"] } }),
        DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      ),
    ).toBeNull();
  });

  it("reorders walker-stored [superclass, include] to Ruby MRO [include, superclass] via classExtends (cai0/2oky5 Task 5)", () => {
    // Walker stores classAncestors["Sub"] = ["Base", "M"] (superclass FIRST).
    // Ruby MRO is [M, Base] — includes before the superclass.
    // classExtends["Sub"] = "Base" identifies the superclass so the linearization
    // sinks it last, making firstDefinerAfter("M","m","Sub") find Base#m.
    const symbolTable = tableWith([
      "base.rb",
      [sym("Base", "Base", "base.rb", []), sym("Base#m", "m", "base.rb", ["Base"])],
    ]);
    const t = firstDefinerAfter(
      "M",
      "m",
      "Sub",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"] }, // walker order: superclass first
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "base.rb", targetSymbolId: "Base#m" });
  });

  // bd tea-rags-mcp-uuux9 — within the include region a LATER `include` sits
  // NEARER, so `super` from the later module continues into the earlier one and
  // `super` from the earlier one has nothing after it.
  it("continues from a LATER include into an EARLIER one (class C; include A; include B)", () => {
    const symbolTable = tableWith(["a.rb", [sym("A", "A", "a.rb", []), sym("A#m", "m", "a.rb", ["A"])]]);
    const t = firstDefinerAfter(
      "B",
      "m",
      "C",
      ctx({ symbolTable, classAncestors: { C: ["A", "B"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "a.rb", targetSymbolId: "A#m" });
  });

  it("does NOT continue from an EARLIER include into a later one (nothing after A in the MRO)", () => {
    const symbolTable = tableWith(["b.rb", [sym("B", "B", "b.rb", []), sym("B#m", "m", "b.rb", ["B"])]]);
    expect(
      firstDefinerAfter(
        "A",
        "m",
        "C",
        ctx({ symbolTable, classAncestors: { C: ["A", "B"] } }),
        DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      ),
    ).toBeNull();
  });
});

// bd tea-rags-mcp-wceck — the self-dispatch hook narrow, and its abstract-stub
// guard. Both narrow-to-1 consumers (the constant-entry strategy and the
// instance-rooted template redirect) route their hook lookup through this ONE
// choke point, so "never emit an edge to a stub" is decided in a single place.
describe("resolveSelfDispatchHookTarget — abstract-stub guard (wceck)", () => {
  const def = (
    symbolId: string,
    shortName: string,
    relPath: string,
    scope: string[],
    isAbstractStub?: true,
  ): SymbolDefinition => ({
    symbolId,
    fqName: symbolId,
    shortName,
    relPath,
    scope,
    ...(isAbstractStub === true ? { isAbstractStub: true } : {}),
  });

  const BASE_FILE = "app/services/base_processor.rb";
  const CONCRETE_FILE = "app/services/form_1040.rb";
  const PLAIN_FILE = "app/services/plain.rb";

  // `BaseProcessor#process_result` is a `raise NotImplementedError` stub;
  // `Form1040` overrides it for real, `Plain` inherits the stub untouched.
  const hookCtx = (): CallContext => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile(BASE_FILE, [
      def("BaseProcessor", "BaseProcessor", BASE_FILE, []),
      def("BaseProcessor#process_result", "process_result", BASE_FILE, ["BaseProcessor"], true),
    ]);
    symbolTable.upsertFile(CONCRETE_FILE, [
      def("Form1040", "Form1040", CONCRETE_FILE, []),
      def("Form1040#process_result", "process_result", CONCRETE_FILE, ["Form1040"]),
    ]);
    symbolTable.upsertFile(PLAIN_FILE, [def("Plain", "Plain", PLAIN_FILE, [])]);
    return ctx({
      symbolTable,
      classAncestors: { Form1040: ["BaseProcessor"], Plain: ["BaseProcessor"] },
    });
  };

  it("resolves the hook to a concrete override", () => {
    expect(
      resolveSelfDispatchHookTarget("Form1040", "process_result", hookCtx(), DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    ).toEqual({ targetRelPath: CONCRETE_FILE, targetSymbolId: "Form1040#process_result" });
  });

  it("returns null when the MRO walk lands on the base's abstract STUB (no edge to a stub)", () => {
    // `Plain` does not override the hook, so the walk reaches
    // `BaseProcessor#process_result` — a declaration, not a target.
    expect(
      resolveSelfDispatchHookTarget("Plain", "process_result", hookCtx(), DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    ).toBeNull();
  });

  it("returns null for a file-only resolution (never downgrades a narrow to a file edge)", () => {
    // `Plain` resolves to a file but nothing in its chain defines `missing_hook`.
    expect(
      resolveSelfDispatchHookTarget("Plain", "missing_hook", hookCtx(), DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    ).toBeNull();
  });

  it("returns null for a type with no known file at all", () => {
    expect(
      resolveSelfDispatchHookTarget("Unknown", "process_result", hookCtx(), DEFAULT_AMBIGUOUS_RESOLVE_MODE),
    ).toBeNull();
  });
});
