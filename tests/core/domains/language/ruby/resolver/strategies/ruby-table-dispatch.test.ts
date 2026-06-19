import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchTableDef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyTableDispatchResolver,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
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
  callerFile: "app/services/runner.rb",
  callerScope: [],
  imports: [],
  ...over,
});

// Both files carry the class symbol (resolveConstant resolves the file) AND its
// #perform method symbol (the dispatched target), mirroring what the walker emits.
const valueClassFiles = (): [string, NamedSymbol[]][] => [
  [
    "app/jobs/clone.rb",
    [
      sym("Jobs::Clone", "Clone", "app/jobs/clone.rb", ["Jobs"]),
      sym("Jobs::Clone#perform", "perform", "app/jobs/clone.rb", ["Jobs", "Clone"]),
    ],
  ],
  [
    "app/pipelines/clone.rb",
    [
      sym("Pipelines::Clone", "Clone", "app/pipelines/clone.rb", ["Pipelines"]),
      sym("Pipelines::Clone#perform", "perform", "app/pipelines/clone.rb", ["Pipelines", "Clone"]),
    ],
  ],
];

const TCK_TABLE = {
  TCK: [
    {
      relPath: "app/services/registry.rb",
      table: { entries: { JobTemplate: "Jobs::Clone", PipelineTemplate: "Pipelines::Clone" } },
    },
  ],
};

const dispatchCall = (table: string, field: string, key: string | null): CallRef => ({
  callText: `${table}[k].new.${field}`,
  receiver: null,
  member: field,
  startLine: 1,
  dispatch: { table, field, key },
});

describe("RubyTableDispatchResolver (bd tea-rags-mcp-pq02v)", () => {
  const resolver = new RubyTableDispatchResolver(cfg);

  it("fans a dynamic-key registry call out to each value class's #method (registry, 1/N)", () => {
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: TCK_TABLE }),
    );
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.edgeKind === "registry")).toBe(true);
    expect(edges.every((e) => e.confidence === 0.5)).toBe(true);
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["Jobs::Clone#perform", "Pipelines::Clone#perform"]);
  });

  it("narrows a static-key call to the one entry as an exact edge (1.0)", () => {
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", "JobTemplate"),
      ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: TCK_TABLE }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ targetSymbolId: "Jobs::Clone#perform", edgeKind: "exact", confidence: 1 });
  });

  it("drops a value class with no matching #method (never fabricates)", () => {
    const tables = {
      TCK: [{ relPath: "app/services/registry.rb", table: { entries: { a: "Jobs::Clone", b: "Pipelines::Missing" } } }],
    };
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: tables }),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Jobs::Clone#perform"]);
  });

  it("returns [] for a non-dispatch call (no call.dispatch) — leaves cone/dynamic untouched", () => {
    const plain: CallRef = { callText: "x.perform", receiver: "x", member: "perform", startLine: 1 };
    expect(resolver.resolveDispatch(plain, ctx({ symbolTable: tableWith() }))).toEqual([]);
  });

  it("drops an ambiguous table name declared in >1 file with no in-file def", () => {
    const tables = {
      TCK: [
        { relPath: "a.rb", table: { entries: { a: "Jobs::Clone" } } },
        { relPath: "b.rb", table: { entries: { a: "Jobs::Clone" } } },
      ],
    };
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: tables }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] when dispatch.field is null (fieldless dispatch ref — line 36 guard)", () => {
    const fieldlessCall: CallRef = {
      callText: "TCK[k]",
      receiver: null,
      member: "",
      startLine: 1,
      dispatch: { table: "TCK", field: null, key: null },
    };
    expect(
      resolver.resolveDispatch(
        fieldlessCall,
        ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: TCK_TABLE }),
      ),
    ).toEqual([]);
  });

  it("returns [] when table name is present in dispatchTables but with an empty defs array (line 71)", () => {
    // selectTableDef: defs exists but defs.length === 0 → return null
    const tables = { TCK: [] as DispatchTableDef[] };
    expect(
      resolver.resolveDispatch(
        dispatchCall("TCK", "perform", null),
        ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: tables }),
      ),
    ).toEqual([]);
  });

  it("selects the in-file table def when the caller file owns one of two defs (line 73-74)", () => {
    // selectTableDef: defs.length === 2, one matches callerFile (app/services/runner.rb)
    const tables = {
      TCK: [
        { relPath: "app/services/runner.rb", table: { entries: { JobTemplate: "Jobs::Clone" } } },
        { relPath: "other/registry.rb", table: { entries: { JobTemplate: "Pipelines::Clone" } } },
      ],
    };
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", "JobTemplate"),
      ctx({ symbolTable: tableWith(...valueClassFiles()), dispatchTables: tables }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ targetSymbolId: "Jobs::Clone#perform", edgeKind: "exact", confidence: 1 });
  });

  it("deduplicates targets when two registry keys map to the same class#method (line 46 seen.has guard)", () => {
    // seen.has(key) deduplicate: two entries both resolve to Jobs::Clone#perform
    const tables = {
      TCK: [
        {
          relPath: "app/services/registry.rb",
          table: { entries: { KeyA: "Jobs::Clone", KeyB: "Jobs::Clone" } },
        },
      ],
    };
    const t = tableWith([
      "app/jobs/clone.rb",
      [
        sym("Jobs::Clone", "Clone", "app/jobs/clone.rb", ["Jobs"]),
        sym("Jobs::Clone#perform", "perform", "app/jobs/clone.rb", ["Jobs", "Clone"]),
      ],
    ]);
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctx({ symbolTable: t, dispatchTables: tables }),
    );
    // Both keys → same Jobs::Clone#perform; dedup keeps only one
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toBe("Jobs::Clone#perform");
  });

  it("resolves via short-name fallback when no exact fqName#field symbol exists in declaring file (lines 91-97)", () => {
    // resolveClassMethod: lookup("Jobs::Clone#perform") returns [] → filter returns [] (not length 1)
    // → falls through to lookupByShortName("perform") scoped to last segment "Clone"
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("app/jobs/clone.rb", [
      sym("Jobs::Clone", "Clone", "app/jobs/clone.rb", ["Jobs"]),
      // Method stored WITHOUT the fqName prefix (simulates a monkey-patch or alias indexing gap)
      // We use a different fqName so lookup("Jobs::Clone#perform") returns []
      // but lookupByShortName("perform") finds it in the right scope.
      sym("Clone#perform", "perform", "app/jobs/clone.rb", ["Clone"]),
    ]);
    const tables = {
      TCK: [{ relPath: "app/services/registry.rb", table: { entries: { Job: "Jobs::Clone" } } }],
    };
    const edges = resolver.resolveDispatch(
      dispatchCall("TCK", "perform", "Job"),
      ctx({ symbolTable: t, dispatchTables: tables }),
    );
    // short-name "perform" scoped to "Clone" (last segment of "Jobs::Clone") → 1 match → resolves
    expect(edges).toHaveLength(1);
    expect(edges[0].targetSymbolId).toBe("Clone#perform");
  });

  it("drops a value class whose declaring file is not a Ruby file (.ts extension, line 85)", () => {
    // isRubyPath("app/jobs/clone.ts") → false → resolveClassMethod returns null → class dropped
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("app/jobs/clone.ts", [sym("Jobs::Clone", "Clone", "app/jobs/clone.ts", ["Jobs"])]);
    const tables = {
      TCK: [{ relPath: "app/services/registry.rb", table: { entries: { Job: "Jobs::Clone" } } }],
    };
    expect(
      resolver.resolveDispatch(dispatchCall("TCK", "perform", "Job"), ctx({ symbolTable: t, dispatchTables: tables })),
    ).toEqual([]);
  });
});
