import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSImportBasenameSymbolResolutionStrategy,
  TSNamedImportSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { tsOptions: { baseUrl: ".", paths: {} }, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

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
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/**
 * `yard.ts` exports the constant `YARD_CONST` and one unrelated function. The
 * constant is NOT in the table on purpose: `tsNameOf` names classes, functions
 * and methods, so a module-level `const` leaves no symbol behind — which is
 * exactly the fact that separates a container constant from an imported class.
 */
const constantModule = (): InMemoryGlobalSymbolTable =>
  tableWith(
    ["src/yard.ts", [sym("parseYard", "parseYard", "src/yard.ts", [])]],
    ["src/fallback.ts", [sym("describeFallback", "describeFallback", "src/fallback.ts", [])]],
  );

/**
 * bd tea-rags-mcp-4kx9f — the import-mapping passes' file-only fallback.
 *
 * INVARIANT: a call whose MEMBER is a builtin container operation
 * (`Set#has`, `RegExp#test`, `Array#map`, …) never yields an edge into the file
 * that merely DECLARES the receiver constant. `YARD_CONST.test(text)` enters
 * `RegExp.prototype.test`, not `yard.ts`, so an edge on `yard.ts` is fabricated.
 *
 * `targetsExternalImport` could not see this shape before: the import maps to a
 * project file, so the specifier-based cases are all false by construction, and
 * `namedImport` carried no guard at all. The receiver being absent from the
 * symbol table is what makes the member vocabulary safe here — an imported
 * CLASS is a symbol, and keeps every edge it had.
 */
describe("TSNamedImportSymbolResolutionStrategy — imported-constant container member (bd tea-rags-mcp-4kx9f)", () => {
  const strat = new TSNamedImportSymbolResolutionStrategy(cfg);

  const imports = [{ importText: "./yard.js", startLine: 1, importedNames: ["YARD_CONST"] }];

  it("continues instead of emitting a file-only edge on the declaring file (YARD_CONST.test(text))", () => {
    const call: CallRef = { callText: "YARD_CONST.test(text)", receiver: "YARD_CONST", member: "test", startLine: 9 };
    const outcome = strat.attempt(call, ctx({ symbolTable: constantModule(), imports }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for an imported array constant iterated over (UNSUPPORTED_FALLBACK.map(f => f.language))", () => {
    const call: CallRef = {
      callText: "UNSUPPORTED_FALLBACK.map((f) => f.language)",
      receiver: "UNSUPPORTED_FALLBACK",
      member: "map",
      startLine: 9,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: constantModule(),
        imports: [{ importText: "./fallback.js", startLine: 1, importedNames: ["UNSUPPORTED_FALLBACK"] }],
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for an imported set constant asked for membership (ECMASCRIPT_GLOBALS.has(receiver))", () => {
    const call: CallRef = {
      callText: "ECMASCRIPT_GLOBALS.has(receiver)",
      receiver: "ECMASCRIPT_GLOBALS",
      member: "has",
      startLine: 9,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: constantModule(),
        imports: [{ importText: "./yard.js", startLine: 1, importedNames: ["ECMASCRIPT_GLOBALS"] }],
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("STILL emits the file-only edge for an imported CLASS whose member is not indexed (RankModule.map(x))", () => {
    const call: CallRef = { callText: "RankModule.map(x)", receiver: "RankModule", member: "map", startLine: 9 };
    const symbolTable = tableWith(["src/rank-module.ts", [sym("RankModule", "RankModule", "src/rank-module.ts", [])]]);
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        imports: [{ importText: "./rank-module.js", startLine: 1, importedNames: ["RankModule"] }],
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/rank-module.ts", targetSymbolId: null },
    });
  });

  it("STILL emits the file-only edge for an imported constant called with project vocabulary (REGISTRY.register(x))", () => {
    const call: CallRef = { callText: "REGISTRY.register(x)", receiver: "REGISTRY", member: "register", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: constantModule(),
        imports: [{ importText: "./yard.js", startLine: 1, importedNames: ["REGISTRY"] }],
      }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/yard.ts", targetSymbolId: null } });
  });

  it("STILL pins the symbol when the declaring file really defines that member (FORMATTERS.map(x))", () => {
    const call: CallRef = { callText: "FORMATTERS.map(x)", receiver: "FORMATTERS", member: "map", startLine: 9 };
    const symbolTable = tableWith(["src/formatters.ts", [sym("map", "map", "src/formatters.ts", [])]]);
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        imports: [{ importText: "./formatters.js", startLine: 1, importedNames: ["FORMATTERS"] }],
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/formatters.ts", targetSymbolId: "map" },
    });
  });
});

/**
 * bd tea-rags-mcp-4kx9f — the same guard on the basename pass, which reaches the
 * shape from the other side: it compares the receiver TEXT to the import
 * specifier's basename, so a local `sessions` array collides with a `sessions.ts`
 * module the caller happens to import. The receiver is not a symbol and the
 * member is `Array#map`, so the edge is fabricated exactly as above.
 */
describe("TSImportBasenameSymbolResolutionStrategy — imported-constant container member (bd tea-rags-mcp-4kx9f)", () => {
  const strat = new TSImportBasenameSymbolResolutionStrategy(cfg);

  it("continues for a local array colliding with an imported module basename (sessions.map(s => s.timestamp))", () => {
    const call: CallRef = {
      callText: "sessions.map((s) => s.timestamp)",
      receiver: "sessions",
      member: "map",
      startLine: 9,
    };
    const symbolTable = tableWith([
      "src/sessions.ts",
      [sym("groupIntoSessions", "groupIntoSessions", "src/sessions.ts", [])],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        imports: [{ importText: "./sessions.js", startLine: 1, importedNames: ["groupIntoSessions"] }],
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("STILL emits the file-only edge for the kebab→Pascal convention it exists for (RankModule.render(x))", () => {
    const call: CallRef = { callText: "RankModule.render(x)", receiver: "RankModule", member: "render", startLine: 9 };
    const symbolTable = tableWith(["src/rank-module.ts", [sym("RankModule", "RankModule", "src/rank-module.ts", [])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, imports: [{ importText: "./rank-module.js", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/rank-module.ts", targetSymbolId: null },
    });
  });
});

/**
 * bd tea-rags-mcp-4kx9f — end to end. The guard CONTINUEs, so the value of the
 * fix depends on no later pass picking the call up: `globalShortName` must
 * decline it too, which it does through the same predicate.
 */
describe("TSCallResolver.resolve — no phantom edge for an imported container constant (bd tea-rags-mcp-4kx9f)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, DEFAULT_AMBIGUOUS_RESOLVE_MODE);

  it("declines YARD_CONST.test(text) rather than emitting an edge into the declaring file", () => {
    const call: CallRef = { callText: "YARD_CONST.test(text)", receiver: "YARD_CONST", member: "test", startLine: 9 };
    const symbolTable = tableWith(
      ["src/yard.ts", [sym("parseYard", "parseYard", "src/yard.ts", [])]],
      ["src/matcher.ts", [sym("PathMatcher#test", "test", "src/matcher.ts", ["PathMatcher"])]],
    );
    const context = ctx({
      symbolTable,
      imports: [{ importText: "./yard.js", startLine: 1, importedNames: ["YARD_CONST"] }],
    });
    expect(resolver.resolve(call, context)).toBeNull();
  });
});

/**
 * bd tea-rags-mcp-4kx9f — the classifier half. A call declined BECAUSE it enters
 * a builtin container must also leave the internal `resolveSuccessRate`
 * denominator; otherwise the resolver is scored as having missed a call it was
 * right to refuse. One predicate answers both questions, as for bd 6b3gj.
 */
describe("TSCallResolver.targetsExternalImport — imported container constant (bd tea-rags-mcp-4kx9f)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a container member on an imported constant (YARD_CONST.test(text))", () => {
    const call: CallRef = { callText: "YARD_CONST.test(text)", receiver: "YARD_CONST", member: "test", startLine: 9 };
    const context = ctx({
      symbolTable: constantModule(),
      imports: [{ importText: "./yard.js", startLine: 1, importedNames: ["YARD_CONST"] }],
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(true);
  });

  it("flags a container member on a receiver matching an imported module basename (sessions.filter(s => s.isFix))", () => {
    const call: CallRef = {
      callText: "sessions.filter((s) => s.isFix)",
      receiver: "sessions",
      member: "filter",
      startLine: 9,
    };
    const context = ctx({
      symbolTable: constantModule(),
      imports: [{ importText: "./sessions.js", startLine: 1, importedNames: ["groupIntoSessions"] }],
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(true);
  });

  it("does NOT flag a container-named member on an imported CLASS (Matcher.test(x))", () => {
    const call: CallRef = { callText: "Matcher.test(x)", receiver: "Matcher", member: "test", startLine: 9 };
    const symbolTable = tableWith(["src/matcher.ts", [sym("Matcher", "Matcher", "src/matcher.ts", [])]]);
    const context = ctx({
      symbolTable,
      imports: [{ importText: "./matcher.js", startLine: 1, importedNames: ["Matcher"] }],
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(false);
  });

  it("does NOT flag an imported constant called with ordinary project vocabulary (REGISTRY.register(x))", () => {
    const call: CallRef = { callText: "REGISTRY.register(x)", receiver: "REGISTRY", member: "register", startLine: 9 };
    const context = ctx({
      symbolTable: constantModule(),
      imports: [{ importText: "./yard.js", startLine: 1, importedNames: ["REGISTRY"] }],
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(false);
  });

  it("does NOT flag a container member on a receiver no import binds (local.map(f))", () => {
    const call: CallRef = { callText: "local.map(f)", receiver: "local", member: "map", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: constantModule() }))).toBe(false);
  });
});
