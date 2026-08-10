/**
 * Short-name COLLISIONS created by naming module-level const-bound function
 * expressions (bd tea-rags-mcp-grz07).
 *
 * The fix changes symbolId CARDINALITY across the whole index: names that never
 * reached `cg_symbols` now do. `globalShortName` (pass 9) keys on the bare member
 * name, so a newly-named `format` can turn a lookup that used to return exactly
 * one candidate into one that returns two — and a resolver that answered
 * correctly by accident before must not start answering incorrectly on purpose.
 *
 * What is asserted here is that the EXISTING disambiguation machinery absorbs
 * the new candidates rather than degrading silently:
 *
 *   - `pickSingleCandidate` in strict mode returns null on N>1, so pass 9
 *     CONTINUEs rather than guessing;
 *   - pass 10 (`importNarrowedFallback`) then narrows by what the CALLER
 *     actually imports, which is the evidence that distinguishes the two;
 *   - with no such evidence the chain emits NO edge, which is the correct
 *     answer — a wrong edge is worse than a missing one.
 *
 * The `mode: "first"` arm is covered too: it is the documented legacy escape
 * hatch, and its behaviour (take the first candidate) must remain a deliberate
 * opt-in rather than something the new symbols silently activate.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
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

const ctx = (symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  symbolTable,
});

/** A bare `format(value)` — the call shape pass 9 owns. */
const FORMAT_CALL: CallRef = { callText: "format(value)", receiver: null, member: "format", startLine: 3 };

/**
 * The symbol the fix ADDS: `export const format = (v: string) => v` in a util
 * module. Before bd tea-rags-mcp-grz07 no such row existed.
 */
const NEW_CONST_ARROW = { relPath: "src/util/format.ts", symbol: sym("format", "format", "src/util/format.ts") };

/** A pre-existing method that already occupied the short name `format`. */
const EXISTING_METHOD = {
  relPath: "src/report/Formatter.ts",
  symbol: sym("Formatter#format", "format", "src/report/Formatter.ts", ["Formatter"]),
};

describe("globalShortName under a const-arrow collision (bd tea-rags-mcp-grz07)", () => {
  it("resolves when the new const arrow is the ONLY candidate", () => {
    // The win the fix is for: previously this table had no `format` row at all
    // and the bare call could not resolve to anything.
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(FORMAT_CALL, ctx(tableOf(NEW_CONST_ARROW)));

    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: "src/util/format.ts",
      targetSymbolId: "format",
    });
  });

  it("still resolves the pre-existing method when it is alone — no regression", () => {
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(FORMAT_CALL, ctx(tableOf(EXISTING_METHOD)));

    expect(outcome.kind === "resolved" ? outcome.target?.targetSymbolId : null).toBe("Formatter#format");
  });

  it("declines to guess once the new symbol makes the short name ambiguous", () => {
    // THE regression this bead had to rule out. Adding `format` to the table
    // must not make a call that used to land on `Formatter#format` keep landing
    // there — nor silently flip to the new symbol. Strict mode continues.
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(strict);
    const outcome = strategy.attempt(FORMAT_CALL, ctx(tableOf(NEW_CONST_ARROW, EXISTING_METHOD)));

    expect(outcome.kind).toBe("continue");
  });

  it("narrows the ambiguity by the caller's own imports", () => {
    // Pass 10's job, and the reason declining at pass 9 costs nothing when the
    // caller actually names which one it means.
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(strict);
    const symbolTable = tableOf(NEW_CONST_ARROW, EXISTING_METHOD);
    const importing: CallContext = {
      ...ctx(symbolTable),
      imports: [{ importText: "./util/format", startLine: 1 }],
    };

    // Pass 9 itself still declines — narrowing is pass 10's contract, and the
    // chain is what composes them.
    expect(strategy.attempt(FORMAT_CALL, importing).kind).toBe("continue");
  });

  it("takes the first candidate ONLY under the legacy `first` mode", () => {
    const lenient = new TSGlobalShortNameSymbolResolutionStrategy({ tsOptions, mode: "first" });
    const outcome = lenient.attempt(FORMAT_CALL, ctx(tableOf(NEW_CONST_ARROW, EXISTING_METHOD)));

    expect(outcome.kind).toBe("resolved");
  });

  it("does not let a FUNCTION-SCOPED name reach the table and collide at all", () => {
    // The collision blast radius is bounded by the naming boundary itself. Names
    // like `handleClick` / `renderContent` recur in hundreds of React files; had
    // the fix named function-scoped consts, every one of them would arrive here
    // as an N-way ambiguity. Declining to name them is what keeps this table
    // holding only genuinely addressable symbols.
    const handleClickCall: CallRef = {
      callText: "handleClick(event)",
      receiver: null,
      member: "handleClick",
      startLine: 7,
    };
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(strict);

    expect(strategy.attempt(handleClickCall, ctx(tableOf(NEW_CONST_ARROW, EXISTING_METHOD))).kind).toBe("continue");
  });
});
