/**
 * Host-class member aliasing (bd tea-rags-mcp-63l69 part 1).
 *
 * A mixin/concern member is keyed by its DEFINER (`Account::Suspensions.suspended`),
 * so a graph query naming the HOST (`Account.suspended`) has no node of its own.
 * `resolveInheritedMemberDefiner` walks the persisted `cg_symbols_inheritance`
 * rows UP from the owner, in the MRO order `MapHierarchyView` uses (prepend ▸
 * include/extend ▸ implements ▸ super, a module's own ancestors right after it),
 * and answers the first ancestor that defines `<ancestor><sep><member>`.
 *
 * Invariants under test:
 *   - an id with its own `cg_symbols` row is never aliased;
 *   - the separator (`#` / `.`) is preserved, never swapped;
 *   - MRO precedence decides between several defining ancestors — within one
 *     rank a LATER include/extend/prepend sits nearer, a base list reads as
 *     written (bd tea-rags-mcp-u0t4p);
 *   - a genuine tie (same parent, same MRO rank, same ordinal) aliases nothing;
 *   - a cyclic hierarchy terminates.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import type { InheritanceEdgeRow, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { resolveInheritedMemberDefiner } from "../../../../../src/core/domains/trajectory/codegraph/inherited-member-definer.js";

function sym(relPath: string, symbolId: string): SymbolDefinition {
  const cut = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  return { symbolId, fqName: symbolId, shortName: symbolId.slice(cut + 1), relPath, scope: [symbolId.slice(0, cut)] };
}

function inh(source: string, ancestor: string, kind: InheritanceEdgeRow["kind"], ordinal: number): InheritanceEdgeRow {
  return {
    sourceFqName: source,
    sourceSymbolId: source,
    ancestorFqName: ancestor,
    ancestorSymbolId: ancestor,
    kind,
    ordinal,
  };
}

describe("resolveInheritedMemberDefiner (bd tea-rags-mcp-63l69)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-inherited-member-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);

    // class Account < ApplicationRecord
    //   prepend Account::Override
    //   include Account::Suspensions   (which itself includes Deep)
    //   include Account::Silences
    await db.upsertSymbols("account.rb", [sym("account.rb", "Account#own")]);
    await db.upsertSymbols("suspensions.rb", [
      sym("suspensions.rb", "Account::Suspensions.suspended"),
      sym("suspensions.rb", "Account::Suspensions.shared"),
      sym("suspensions.rb", "Account::Suspensions#own"),
      sym("suspensions.rb", "Account::Suspensions.order_pick"),
    ]);
    await db.upsertSymbols("silences.rb", [
      sym("silences.rb", "Account::Silences.over_super"),
      sym("silences.rb", "Account::Silences.order_pick"),
    ]);
    await db.upsertSymbols("override.rb", [sym("override.rb", "Account::Override.shared")]);
    await db.upsertSymbols("deep.rb", [sym("deep.rb", "Deep.deep"), sym("deep.rb", "Deep.dfs")]);
    await db.upsertSymbols("application_record.rb", [
      sym("application_record.rb", "ApplicationRecord.base_scope"),
      sym("application_record.rb", "ApplicationRecord.over_super"),
      sym("application_record.rb", "ApplicationRecord.dfs"),
    ]);

    await db.upsertFile(
      { relPath: "account.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        inheritance: [
          inh("Account", "ApplicationRecord", "super", 0),
          inh("Account", "Account::Override", "prepend", 0),
          inh("Account", "Account::Suspensions", "include", 0),
          inh("Account", "Account::Silences", "include", 1),
        ],
      },
    );
    await db.upsertFile(
      { relPath: "suspensions.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Account::Suspensions", "Deep", "include", 0)] },
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aliases a host-class static member onto the included definer", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account.suspended")).toBe("Account::Suspensions.suspended");
  });

  it("never aliases an id that has its own node", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account#own")).toBeNull();
  });

  it("preserves the separator — an instance query does not match a static definer", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account#suspended")).toBeNull();
  });

  it("reaches the superclass when no mixin defines the member", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account.base_scope")).toBe("ApplicationRecord.base_scope");
  });

  it("prefers a prepended module over an included one", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account.shared")).toBe("Account::Override.shared");
  });

  it("prefers an included module over the superclass", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account.over_super")).toBe("Account::Silences.over_super");
  });

  it("walks transitively — a module's own ancestors come before the host's superclass", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account.deep")).toBe("Deep.deep");
    expect(await resolveInheritedMemberDefiner(db, "Account.dfs")).toBe("Deep.dfs");
  });

  it("the LATER include wins between two included definers (include A; include B → B)", async () => {
    // bd tea-rags-mcp-u0t4p: Ruby's MRO is [Account, Silences, Suspensions, …].
    expect(await resolveInheritedMemberDefiner(db, "Account.order_pick")).toBe("Account::Silences.order_pick");
  });

  it("the LATER prepend wins between two prepended definers (prepend A; prepend B → B)", async () => {
    await db.upsertSymbols("pa.rb", [sym("pa.rb", "PA#m")]);
    await db.upsertSymbols("pb.rb", [sym("pb.rb", "PB#m")]);
    await db.upsertFile(
      { relPath: "phost.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        inheritance: [inh("PHost", "PA", "prepend", 0), inh("PHost", "PB", "prepend", 1)],
      },
    );
    expect(await resolveInheritedMemberDefiner(db, "PHost#m")).toBe("PB#m");
  });

  it("keeps base-list order for multiple superclasses (Python class C(A, B) → A)", async () => {
    await db.upsertSymbols("pya.py", [sym("pya.py", "PyA#m")]);
    await db.upsertSymbols("pyb.py", [sym("pyb.py", "PyB#m")]);
    await db.upsertFile(
      { relPath: "pyc.py", language: "python" },
      {
        fileEdges: [],
        methodEdges: [],
        inheritance: [inh("PyC", "PyB", "super", 1), inh("PyC", "PyA", "super", 0)],
      },
    );
    expect(await resolveInheritedMemberDefiner(db, "PyC#m")).toBe("PyA#m");
  });

  it("aliases nothing when no ancestor defines the member", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account.missing")).toBeNull();
  });

  it("aliases nothing for a bare id with no member segment", async () => {
    expect(await resolveInheritedMemberDefiner(db, "Account")).toBeNull();
  });

  it("aliases nothing on a genuine tie — same parent, same MRO rank, same ordinal", async () => {
    // `include A` and `extend B` both carry per-kind ordinal 0 and rank 1.
    await db.upsertSymbols("a.rb", [sym("a.rb", "A.tied")]);
    await db.upsertSymbols("b.rb", [sym("b.rb", "B.tied")]);
    await db.upsertFile(
      { relPath: "host.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Host", "A", "include", 0), inh("Host", "B", "extend", 0)] },
    );
    expect(await resolveInheritedMemberDefiner(db, "Host.tied")).toBeNull();
  });

  it("terminates on a cyclic hierarchy", async () => {
    await db.upsertSymbols("y.rb", [sym("y.rb", "Y.found")]);
    await db.upsertFile(
      { relPath: "x.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("X", "Z", "include", 0), inh("X", "Y", "include", 1)] },
    );
    await db.upsertFile(
      { relPath: "z.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Z", "X", "include", 0)] },
    );
    expect(await resolveInheritedMemberDefiner(db, "X.found")).toBe("Y.found");
    expect(await resolveInheritedMemberDefiner(db, "X.nowhere")).toBeNull();
  });
});
