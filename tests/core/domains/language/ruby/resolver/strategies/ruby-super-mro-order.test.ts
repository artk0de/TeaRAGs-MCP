/**
 * `super` dispatches along the LINEARIZED MRO, not the walker's storage order
 * (bd tea-rags-mcp-uuux9).
 *
 * `classAncestors` is written by the walker as `[superclass, ...includes]` —
 * AST insertion order, in which the superclass leads. Ruby ranks it the other
 * way round: every `include` sits between the class and its superclass, and a
 * later `include` sits nearer than an earlier one. Iterating the raw list sends
 * `super` to the superclass while a mixin in between actually defines the
 * method, so the edge points past the definition Ruby would run.
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
const strat = new RubySuperSymbolResolutionStrategy(cfg);

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

const superCall = (member: string): CallRef => ({
  callText: "super",
  receiver: SUPER_RECEIVER_SENTINEL,
  member,
  startLine: 10,
});

describe("RubySuperSymbolResolutionStrategy — MRO ordering (uuux9)", () => {
  //   app/models/base.rb      class Base;  def save; end
  //   app/models/auditable.rb module Auditable; def save; super; end
  //   app/models/sub.rb       class Sub < Base; include Auditable; def save; super; end
  //
  // Ruby: Sub.ancestors == [Sub, Auditable, Base] — `super` from Sub#save runs
  // Auditable#save, and only ITS `super` reaches Base#save.
  const includeBeatsSuperclassCtx = (): CallContext => ({
    callerFile: "app/models/sub.rb",
    callerScope: ["Sub"],
    callerSymbolId: "Sub#save",
    imports: [],
    symbolTable: tableWith(
      [
        "app/models/base.rb",
        [sym("Base", "Base", "app/models/base.rb", []), sym("Base#save", "save", "app/models/base.rb", ["Base"])],
      ],
      [
        "app/models/auditable.rb",
        [
          sym("Auditable", "Auditable", "app/models/auditable.rb", []),
          sym("Auditable#save", "save", "app/models/auditable.rb", ["Auditable"]),
        ],
      ],
      [
        "app/models/sub.rb",
        [sym("Sub", "Sub", "app/models/sub.rb", []), sym("Sub#save", "save", "app/models/sub.rb", ["Sub"])],
      ],
    ),
    // Walker storage order: superclass FIRST, then the include.
    classAncestors: { Sub: ["Base", "Auditable"] },
    classExtends: { Sub: "Base" },
  });

  it("dispatches to an INCLUDED module before the superclass", () => {
    expect(strat.attempt(superCall("save"), includeBeatsSuperclassCtx())).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/auditable.rb", targetSymbolId: "Auditable#save" },
    });
  });

  //   class C
  //     include Loggable   # declared first  → FARTHER
  //     include Timed      # declared second → NEARER
  //   end
  //
  // Ruby: C.ancestors == [C, Timed, Loggable].
  const twoIncludesCtx = (): CallContext => ({
    callerFile: "app/c.rb",
    callerScope: ["C"],
    callerSymbolId: "C#run",
    imports: [],
    symbolTable: tableWith(
      [
        "app/loggable.rb",
        [
          sym("Loggable", "Loggable", "app/loggable.rb", []),
          sym("Loggable#run", "run", "app/loggable.rb", ["Loggable"]),
        ],
      ],
      ["app/timed.rb", [sym("Timed", "Timed", "app/timed.rb", []), sym("Timed#run", "run", "app/timed.rb", ["Timed"])]],
      ["app/c.rb", [sym("C", "C", "app/c.rb", []), sym("C#run", "run", "app/c.rb", ["C"])]],
    ),
    classAncestors: { C: ["Loggable", "Timed"] },
  });

  it("dispatches to the LAST-declared include, not the first", () => {
    expect(strat.attempt(superCall("run"), twoIncludesCtx())).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/timed.rb", targetSymbolId: "Timed#run" },
    });
  });
});
