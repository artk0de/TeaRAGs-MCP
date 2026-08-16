/**
 * What naming class-property arrows BUYS the resolver chain (bd
 * tea-rags-mcp-5ldqu).
 *
 * The bead's evidence is a precision defect, not a recall one:
 * `fetcher.request()` in a generated API client is a `localVar` receiver the
 * walker already types (`const fetcher = new AdminentrypointPostFetcher()`), so
 * pass 4 (`localBinding`) is holding the right answer and asking the symbol
 * table for `AdminentrypointPostFetcher#request` — which did not exist, because
 * `request` is a `public_field_definition` no gate named. Pass 4 therefore
 * CONTINUEd and a later, weaker pass landed the call on a same-named `request`
 * in an unrelated file.
 *
 * These tests pin the exchange at the strategy level, where the symbol table is
 * explicit: with the row present the local type wins; without it the same table
 * gives pass 4 nothing and it declines rather than guessing.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSLocalBindingSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };
const strict: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[] = []): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableOf = (...entries: { relPath: string; symbol: NamedSymbol }[]): InMemoryGlobalSymbolTable => {
  const built = new InMemoryGlobalSymbolTable();
  for (const { relPath, symbol } of entries) built.upsertFile(relPath, [symbol]);
  return built;
};

const FETCHER_FILE = "app/javascript/api/fetchers/AdminentrypointPostFetcher.ts";
const API_CLIENT_FILE = "app/javascript/react-app/lib/apiClient/apiClient.ts";

/** The row this bead ADDS: `class AdminentrypointPostFetcher { request = async () => {} }`. */
const CLASS_PROPERTY_ARROW = {
  relPath: FETCHER_FILE,
  symbol: sym("AdminentrypointPostFetcher#request", "request", FETCHER_FILE, ["AdminentrypointPostFetcher"]),
};

/** Its static twin, `static build = () => new AdminentrypointPostFetcher()`. */
const STATIC_CLASS_PROPERTY_ARROW = {
  relPath: FETCHER_FILE,
  symbol: sym("AdminentrypointPostFetcher.build", "build", FETCHER_FILE, ["AdminentrypointPostFetcher"]),
};

/** The unrelated same-named symbol the call used to land on. */
const DECOY = { relPath: API_CLIENT_FILE, symbol: sym("request", "request", API_CLIENT_FILE) };

/** `fetcher.request(...)` — a `localVar` receiver, which is pass 4's shape. */
const REQUEST_CALL: CallRef = {
  callText: "fetcher.request(url)",
  receiver: "fetcher",
  member: "request",
  startLine: 41,
};

const ctx = (symbolTable: InMemoryGlobalSymbolTable, type: string): CallContext => ({
  callerFile: "app/javascript/api/hooks/AdminentrypointPostHook.ts",
  callerScope: [],
  imports: [],
  symbolTable,
  localBindings: { fetcher: [{ line: 38, type }] },
});

describe("localBinding on a class-property arrow (bd tea-rags-mcp-5ldqu)", () => {
  it("pins the call to the field on the bound class, not to the same-named decoy", () => {
    const strategy = new TSLocalBindingSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(
      REQUEST_CALL,
      ctx(tableOf(CLASS_PROPERTY_ARROW, DECOY), "AdminentrypointPostFetcher"),
    );

    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: FETCHER_FILE,
      targetSymbolId: "AdminentrypointPostFetcher#request",
    });
  });

  it("declines when the class-property row is absent, leaving the decoy to a later pass", () => {
    // The pre-bead state, stated as an invariant rather than as history: pass 4
    // never guesses. With no `AdminentrypointPostFetcher#request` row it hands
    // the call on, and what lands it on the wrong file is a later, weaker pass.
    const strategy = new TSLocalBindingSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(REQUEST_CALL, ctx(tableOf(DECOY), "AdminentrypointPostFetcher"));

    expect(outcome.kind).toBe("continue");
  });

  it("reaches the STATIC field through the `.` form when the instance form misses", () => {
    // `resolveByLocalType` tries `Type#member` then `Type.member`; the second
    // arm is what a `static build = () => …` field needs, and it only works
    // because the walker composed the id with `.`.
    const strategy = new TSLocalBindingSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(
      { callText: "fetcher.build()", receiver: "fetcher", member: "build", startLine: 41 },
      ctx(tableOf(STATIC_CLASS_PROPERTY_ARROW), "AdminentrypointPostFetcher"),
    );

    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: FETCHER_FILE,
      targetSymbolId: "AdminentrypointPostFetcher.build",
    });
  });

  it("still declines when the bound type is a DIFFERENT class that has no such field", () => {
    // The new rows must not make pass 4 looser: a local typed to something else
    // gets no answer, however many `request` symbols the table holds.
    const strategy = new TSLocalBindingSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(REQUEST_CALL, ctx(tableOf(CLASS_PROPERTY_ARROW, DECOY), "GetFetcher"));

    expect(outcome.kind).toBe("continue");
  });
});
