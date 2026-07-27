/**
 * bd tea-rags-mcp-83cl7 — core-homonym classification for an UNRESOLVED call.
 *
 * A failed call is `coreAmbiguous` ONLY when ALL THREE hold:
 *   (a) the member is in the Ruby CORE vocabulary (`RUBY_CORE_MEMBERS`),
 *   (b) the receiver is UNTYPED — no localBinding / ivar / chain / param type,
 *   (c) the call actually failed resolution (the provider's contract: this hook
 *       is consulted only for calls the chain could not pin).
 *
 * Precision runs in REVERSE here: over-classification HIDES a real recall hole.
 * The typed-receiver pin below is the guard — if a typed project class genuinely
 * defines the member, the miss stays a miss.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const resolver = new RubyCallResolver();

/** Symbol table with an in-project `Report#each` — the homonym that defeats the
 *  `lookupByShortName === 0` gate and manufactures the phantom miss. */
function tableWithProjectEach(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/models/report.rb", [
    { symbolId: "Report", fqName: "Report", shortName: "Report", relPath: "app/models/report.rb", scope: [] },
    {
      symbolId: "Report#each",
      fqName: "Report#each",
      shortName: "each",
      relPath: "app/models/report.rb",
      scope: ["Report"],
    },
  ]);
  return table;
}

const ctx = (table: InMemoryGlobalSymbolTable, extra?: Partial<CallContext>): CallContext => ({
  callerFile: "app/services/exporter.rb",
  callerScope: ["Exporter"],
  imports: [],
  symbolTable: table,
  ...extra,
});

const call = (receiver: string | null, member: string): CallRef => ({
  callText: receiver === null ? `${member}` : `${receiver}.${member}`,
  receiver,
  member,
  startLine: 10,
});

describe("RubyCallResolver.targetsCoreAmbiguousMember (83cl7)", () => {
  it("classifies an UNTYPED chain receiver calling a core member", () => {
    expect(resolver.targetsCoreAmbiguousMember(call("row.cells", "each"), ctx(tableWithProjectEach()))).toBe(true);
  });

  it("classifies an UNTYPED dynamic receiver calling a core member", () => {
    expect(resolver.targetsCoreAmbiguousMember(call("payload", "to_s"), ctx(tableWithProjectEach()))).toBe(true);
  });

  it("does NOT classify a TYPED local receiver whose class defines the member (reverse-precision pin)", () => {
    const table = tableWithProjectEach();
    const callCtx = ctx(table, {
      localBindings: { report: [{ type: "Report", line: 1, valueKind: "instance" }] },
    });
    expect(resolver.targetsCoreAmbiguousMember(call("report", "each"), callCtx)).toBe(false);
  });

  it("does NOT classify a TYPED @ivar receiver", () => {
    const table = tableWithProjectEach();
    const callCtx = ctx(table, { callerScope: ["Exporter"], ivarTypes: { Exporter: { "@report": "Report" } } });
    expect(resolver.targetsCoreAmbiguousMember(call("@report", "each"), callCtx)).toBe(false);
  });

  it("does NOT classify a bare call (implicit self is typed by the enclosing class)", () => {
    expect(resolver.targetsCoreAmbiguousMember(call(null, "each"), ctx(tableWithProjectEach()))).toBe(false);
  });

  it("does NOT classify self / super / constant receivers", () => {
    const table = tableWithProjectEach();
    expect(resolver.targetsCoreAmbiguousMember(call("self", "each"), ctx(table))).toBe(false);
    expect(resolver.targetsCoreAmbiguousMember(call("<super>", "each"), ctx(table))).toBe(false);
    expect(resolver.targetsCoreAmbiguousMember(call("Report", "each"), ctx(table))).toBe(false);
  });

  it("does NOT classify a NON-core member on an untyped receiver", () => {
    expect(
      resolver.targetsCoreAmbiguousMember(call("payload", "recalculate_totals"), ctx(tableWithProjectEach())),
    ).toBe(false);
  });

  it("does NOT classify a service-object `call` on an untyped receiver", () => {
    expect(resolver.targetsCoreAmbiguousMember(call("interactor", "call"), ctx(tableWithProjectEach()))).toBe(false);
  });
});
