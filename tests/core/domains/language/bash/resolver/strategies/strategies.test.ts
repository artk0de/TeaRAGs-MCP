import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  BashGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/bash/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope: [],
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "main.sh",
  callerScope: [],
  imports: [],
  ...over,
});

describe("BashGlobalShortNameSymbolResolutionStrategy", () => {
  const strat = new BashGlobalShortNameSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 };

  it("resolves a unique global short-name", () => {
    const symbolTable = tableWith(["helpers.sh", [sym("do_thing", "do_thing", "helpers.sh")]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "helpers.sh", targetSymbolId: "do_thing" },
    });
  });

  it("narrows N>1 ambiguous candidates to the single file the caller sources", () => {
    const symbolTable = tableWith(
      ["scripts/a.sh", [sym("do_thing", "do_thing", "scripts/a.sh")]],
      ["scripts/b.sh", [sym("do_thing", "do_thing", "scripts/b.sh")]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "scripts/main.sh", imports: [{ importText: "./a.sh", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "scripts/a.sh", targetSymbolId: "do_thing" },
    });
  });

  it("continues (strict) when ambiguous and no source list narrows it", () => {
    const symbolTable = tableWith(
      ["a.sh", [sym("do_thing", "do_thing", "a.sh")]],
      ["b.sh", [sym("do_thing", "do_thing", "b.sh")]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the ambiguity cannot be narrowed (caller sources an unrelated file)", () => {
    const symbolTable = tableWith(
      ["scripts/a.sh", [sym("do_thing", "do_thing", "scripts/a.sh")]],
      ["scripts/b.sh", [sym("do_thing", "do_thing", "scripts/b.sh")]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "scripts/main.sh", imports: [{ importText: "./other.sh", startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the short-name is unknown to the table", () => {
    const symbolTable = tableWith(["helpers.sh", [sym("other_fn", "other_fn", "helpers.sh")]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });
});
