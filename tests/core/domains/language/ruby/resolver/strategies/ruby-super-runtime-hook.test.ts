/**
 * Part 2 — runtime-hook super suppression (bd 08tss Part 2).
 *
 * When `super` is called for a Ruby runtime hook method (method_missing,
 * respond_to_missing?, method_added, …) whose only in-project ancestor doesn't
 * define that method, the file-only fallback MUST be suppressed (DROP).
 *
 * These hooks always chain up to BasicObject/Module in the Ruby runtime — an
 * in-project file-only edge would be a fabricated false edge.
 *
 * Non-hook members (e.g. ApplicationRecord#save) MUST still get the file-only
 * fallback edge so real cross-project chains remain intact.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubySuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

describe("RubySuperSymbolResolutionStrategy — runtime hook suppression (bd 08tss Part 2)", () => {
  const strat = new RubySuperSymbolResolutionStrategy(cfg);

  // Part 2a: runtime hooks must DROP even when in-project ancestor's file resolves
  const HOOKS = [
    "method_missing",
    "respond_to_missing?",
    "method_added",
    "method_removed",
    "inherited",
    "included",
    "extended",
    "prepended",
    "const_missing",
    "singleton_method_added",
  ];

  for (const hook of HOOKS) {
    it(`DROPS file-only fallback for runtime hook '${hook}' when ancestor has no definition for it`, () => {
      // Ancestor file IS known (configurable.rb resolves) but has no `${hook}` symbol
      const symbolTable = tableWith([
        "lib/configurable.rb",
        [sym("Configurable", "Configurable", "lib/configurable.rb", [])],
      ]);
      const call: CallRef = {
        callText: `super ${hook}`,
        receiver: SUPER_RECEIVER_SENTINEL,
        member: hook,
        startLine: 5,
      };
      const outcome = strat.attempt(
        call,
        ctx({
          symbolTable,
          callerScope: ["Octokit"],
          classAncestors: { Octokit: ["Configurable"] },
        }),
      );
      // Must DROP — no file-only edge for runtime hooks
      expect(outcome.kind).toBe("drop");
    });
  }

  // Part 2b: non-hook members still get the file-only fallback (regression guard)
  it("still emits file-only edge for a NON-hook member when ancestor file resolves but method is absent", () => {
    const symbolTable = tableWith(["app/base.rb", [sym("ApplicationRecord", "ApplicationRecord", "app/base.rb", [])]]);
    const call: CallRef = {
      callText: "super save",
      receiver: SUPER_RECEIVER_SENTINEL,
      member: "save",
      startLine: 10,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        callerScope: ["MyModel"],
        classAncestors: { MyModel: ["ApplicationRecord"] },
      }),
    );
    expect(outcome.kind).toBe("resolved");
    expect((outcome as { kind: "resolved"; target: unknown }).target).toMatchObject({
      targetRelPath: "app/base.rb",
      targetSymbolId: null,
    });
  });

  // Guard: runtime hook with a METHOD-LEVEL match MUST still resolve (not suppressed)
  it("resolves method_missing to a METHOD-LEVEL match even though it is a runtime hook", () => {
    const symbolTable = tableWith([
      "lib/base.rb",
      [sym("Base", "Base", "lib/base.rb", []), sym("Base#method_missing", "method_missing", "lib/base.rb", ["Base"])],
    ]);
    const call: CallRef = {
      callText: "super method_missing",
      receiver: SUPER_RECEIVER_SENTINEL,
      member: "method_missing",
      startLine: 3,
    };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable,
        callerScope: ["Child"],
        classAncestors: { Child: ["Base"] },
      }),
    );
    expect(outcome.kind).toBe("resolved");
    expect((outcome as { kind: "resolved"; target: unknown }).target).toMatchObject({
      targetRelPath: "lib/base.rb",
      targetSymbolId: "Base#method_missing",
    });
  });
});
