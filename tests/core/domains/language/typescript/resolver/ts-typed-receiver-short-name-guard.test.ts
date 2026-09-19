import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type LocalBinding,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  TSImportNarrowedFallbackSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { receiverBoundToProjectType } from "../../../../../../src/core/domains/language/typescript/resolver/ts-local-receiver.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };
const cfg: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const bind = (type: string, line: number): Record<string, LocalBinding[]> => ({ fetcher: [{ line, type }] });

/**
 * The taxdome generated-fetcher shape, reduced to its three files.
 *
 * `PostFetcher` declares `request` as a class PROPERTY holding an arrow function
 * — a member the walker does not emit as a symbol — so the table carries the
 * class and nothing under `PostFetcher#request`. The only project symbol named
 * `request` is an unrelated top-level function in the api client, which is what
 * `globalShortName` matched and committed to.
 */
const fetcherTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/fetchers/PostFetcher.ts", [
    sym("PostFetcher", "PostFetcher", "src/fetchers/PostFetcher.ts", []),
    sym("PostFetcher#buildUrl", "buildUrl", "src/fetchers/PostFetcher.ts", ["PostFetcher"]),
  ]);
  table.upsertFile("src/lib/apiClient.ts", [sym("request", "request", "src/lib/apiClient.ts", [])]);
  return table;
};

/** Same table, but the bound type genuinely declares the member as a method. */
const declaringTable = (): InMemoryGlobalSymbolTable => {
  const table = fetcherTable();
  table.upsertFile("src/fetchers/PostFetcher.ts", [
    sym("PostFetcher", "PostFetcher", "src/fetchers/PostFetcher.ts", []),
    sym("PostFetcher#request", "request", "src/fetchers/PostFetcher.ts", ["PostFetcher"]),
  ]);
  return table;
};

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "src/hooks/usePost.ts",
  callerScope: [],
  imports: [],
  symbolTable: fetcherTable(),
  ...over,
});

const FETCHER_CALL: CallRef = {
  callText: "fetcher.request()",
  receiver: "fetcher",
  member: "request",
  startLine: 5,
};

/**
 * bd tea-rags-mcp-dubkx — `globalShortName` must not answer a DISPATCHING call
 * whose receiver the walker already typed to a project-declared type.
 *
 * The taxdome oracle recorded 828 `localVar` sites of the generated
 * `fetcher.request()` shape landing on `react-app/lib/apiClient/apiClient.ts#request`
 * — a free function the receiver cannot reach — and a pass-by-pass replay of the
 * production chain over the corpus attributed every one of them to pass 9.
 *
 * The chain KNOWS what `fetcher` is: `TSLocalBindingSymbolResolutionStrategy`
 * (pass 4) read the walker's binding, looked up `PostFetcher#request` and
 * `PostFetcher.request`, and found neither. Reaching pass 9 IS that negative
 * answer. Pass 9 then ignores the receiver entirely and commits to whatever
 * single project symbol shares the member's short name, which is a coincidence
 * of naming rather than evidence about this call.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — typed-receiver guard (bd tea-rags-mcp-dubkx)", () => {
  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, null);

  it("continues for the taxdome generated-fetcher receiver (fetcher.request() on a walker-typed PostFetcher)", () => {
    expect(strategy().attempt(FETCHER_CALL, ctx({ localBindings: bind("PostFetcher", 4) })).kind).toBe("continue");
  });

  // bd tea-rags-mcp-t5cji: a receiver the walker did NOT type is no longer
  // committed by short-name uniqueness at all — with no checker here, the pass
  // continues. Still not THIS guard's case, which is what each asserts first.
  it("stays silent when the walker bound NO type — an untypable receiver is not this guard's case", () => {
    expect(receiverBoundToProjectType(FETCHER_CALL, ctx())).toBe(false);
    expect(strategy().attempt(FETCHER_CALL, ctx()).kind).toBe("continue");
  });

  it("stays silent when the bound type is NOT a project symbol — no evidence about what it declares", () => {
    const context = ctx({ localBindings: bind("AxiosInstance", 4) });
    expect(receiverBoundToProjectType(FETCHER_CALL, context)).toBe(false);
    // …and that absence of evidence no longer lets the unique `request` commit
    // either (bd tea-rags-mcp-t5cji): the taxdome generated-fetcher shape.
    expect(strategy().attempt(FETCHER_CALL, context).kind).toBe("continue");
  });

  it("STILL resolves a BARE call — a free call has no receiver whose type could contradict the match", () => {
    const bare: CallRef = { callText: "request()", receiver: null, member: "request", startLine: 5 };
    expect(strategy().attempt(bare, ctx({ localBindings: bind("PostFetcher", 4) }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/lib/apiClient.ts", targetSymbolId: "request" },
    });
  });

  it("stays silent when the binding is established AFTER the call line — position-aware, not name-keyed", () => {
    const context = ctx({ localBindings: bind("PostFetcher", 9) });
    expect(receiverBoundToProjectType(FETCHER_CALL, context)).toBe(false);
    expect(strategy().attempt(FETCHER_CALL, context).kind).toBe("continue");
  });
});

/**
 * The import-narrowed fallback keeps its own behaviour. Pass 10 is receiver-
 * INFORMED where pass 9 is receiver-blind: it fires only on a genuinely ambiguous
 * short name and picks the candidate the caller can actually reach, which is the
 * designed recovery for a walker-typed INTERFACE receiver whose implementers the
 * table cannot narrow (bd tea-rags-mcp-2qp6). Guarding it the same way would
 * delete that recovery.
 */
describe("TSImportNarrowedFallbackSymbolResolutionStrategy — unaffected (bd tea-rags-mcp-dubkx)", () => {
  it("STILL narrows an ambiguous member for a walker-typed interface receiver", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/store.ts", [sym("Store", "Store", "src/store.ts", [])]);
    table.upsertFile("src/memory-store.ts", [sym("MemoryStore#save", "save", "src/memory-store.ts", ["MemoryStore"])]);
    table.upsertFile("src/remote-store.ts", [sym("RemoteStore#save", "save", "src/remote-store.ts", ["RemoteStore"])]);

    const call: CallRef = { callText: "fetcher.save()", receiver: "fetcher", member: "save", startLine: 5 };
    const outcome = new TSImportNarrowedFallbackSymbolResolutionStrategy(cfg, null).attempt(
      call,
      ctx({
        symbolTable: table,
        localBindings: bind("Store", 4),
        imports: [{ importText: "../memory-store.js", startLine: 1, importedNames: ["MemoryStore"] }],
      }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/memory-store.ts", targetSymbolId: "MemoryStore#save" },
    });
  });
});

/**
 * The same decision through the whole chain. Declining is strictly better than
 * fabricating: the call becomes an internal miss rather than an edge pointing at
 * code it never reaches, and `resolveSuccessRate` drops by exactly the count of
 * edges that were never real.
 */
describe("TSCallResolver — typed-receiver guard end to end (bd tea-rags-mcp-dubkx)", () => {
  it("emits no edge for the generated-fetcher receiver", () => {
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, "/nonexistent-repo-root");
    expect(resolver.resolve(FETCHER_CALL, ctx({ localBindings: bind("PostFetcher", 4) }))).toBeNull();
  });

  it("STILL emits the edge when the bound type declares the member — pass 4 owns it and answers", () => {
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, "/nonexistent-repo-root");
    expect(
      resolver.resolve(FETCHER_CALL, ctx({ symbolTable: declaringTable(), localBindings: bind("PostFetcher", 4) })),
    ).toEqual({
      targetRelPath: "src/fetchers/PostFetcher.ts",
      targetSymbolId: "PostFetcher#request",
    });
  });
});
