/**
 * A LEFT JOIN whose ON clause carries a predicate on the LEFT side alone
 * (`ON s.type_name IS NULL AND t.k = s.k`) cannot be pushed into either input,
 * so DuckDB plans it as a nested-loop join instead of a hash join (bd
 * tea-rags-mcp-3x25d). Measured on taxdome: the `resolvedIdentifiersCte`
 * call-target join spent 22.6s of CPU over 204k rows, and the
 * `getChunkSignalsBulk` page-rank join 3.3-14.3s.
 *
 * The rewrite folds the one-sided predicate into the equi-join key
 * (`ON t.k = CASE WHEN s.type_name IS NULL THEN s.k END`): a row the predicate
 * rejects gets a NULL key, which matches nothing — exactly the false ON clause
 * it replaces. These tests pin the rows each query returns on a fixture that
 * mixes both sides of the predicate over shared keys, so the rewrite has to be
 * output-identical, and pin the plan so the nested loop does not come back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import { resolvedIdentifiersCte } from "../../../../src/core/adapters/duckdb/identifier-store.js";
import { DuckDbMethodEdgeReader } from "../../../../src/core/adapters/duckdb/method-edge-reader.js";
import { fileScopedSymbolKey } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/** Plan operators a one-sided ON predicate degrades the join into. */
const NESTED_LOOP_JOIN = /NESTED_LOOP_JOIN|BLOCKWISE_NL_JOIN|PIECEWISE_MERGE_JOIN/;

describe("one-sided LEFT JOIN predicates become equi-join keys (bd tea-rags-mcp-3x25d)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-equi-key-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function planOf(sql: string, params: unknown[] = []): Promise<string> {
    const rows = await db.queryAll<{ explain_value: string }>(`EXPLAIN ${sql}`, params);
    return rows.map((r) => r.explain_value).join("\n");
  }

  describe("resolvedIdentifiersCte — call_targets join", () => {
    /**
     * Untyped and typed locals in `A#run` share each call key (`load()`,
     * `fetch()`), so a call-return type must reach the untyped row only.
     * `fetch()` returns `Result<Item>` and one local keeps the wrapper; `void()`
     * returns a wrapper around nothing; `missing()` has no edge at all.
     */
    async function seedIdentifiers(): Promise<void> {
      await db.run(
        `INSERT INTO cg_identifiers
           (rel_path, owner_symbol_id, kind, name, type_name, type_source, line,
            bound_call_expression, type_multiplicity, bound_call_unwrapped, return_wrapper)
         VALUES
           ('a.ts', 'A#run', 'local', 'doc',       NULL,    NULL,         1, 'load()',    'one', NULL,  NULL),
           ('a.ts', 'A#run', 'local', 'typed',     'Typed', 'annotation', 2, 'load()',    'one', NULL,  NULL),
           ('a.ts', 'A#run', 'local', 'item',      NULL,    NULL,         3, 'fetch()',   'one', true,  NULL),
           ('a.ts', 'A#run', 'local', 'wrapped',   NULL,    NULL,         4, 'fetch()',   'one', false, NULL),
           ('a.ts', 'A#run', 'local', 'other',     'Other', 'annotation', 5, 'fetch()',   'many', false, NULL),
           ('a.ts', 'A#run', 'local', 'nothing',   NULL,    NULL,         6, 'void()',    'one', true,  NULL),
           ('a.ts', 'A#run', 'local', 'promise',   NULL,    NULL,         7, 'void()',    'one', false, NULL),
           ('a.ts', 'A#run', 'local', 'orphan',    NULL,    NULL,         8, 'missing()', 'one', NULL,  NULL),
           ('b.ts', 'B#load',  'return', 'load',  'Doc',  'annotation', 1, NULL, 'many', NULL, NULL),
           ('c.ts', 'C#fetch', 'return', 'fetch', 'Item', 'annotation', 1, NULL, 'one',  NULL, 'Result'),
           ('d.ts', 'D#void',  'return', 'void',  NULL,   NULL,         1, NULL, 'one',  NULL, 'Promise')`,
      );
      await db.run(
        `INSERT INTO cg_symbols_edges_method
           (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key, target_symbol_id, edge_kind)
         VALUES
           ('A#run', 'a.ts', 'b.ts', 'load()',  'b.ts::B#load',  'B#load',  'exact'),
           ('A#run', 'a.ts', 'c.ts', 'fetch()', 'c.ts::C#fetch', 'C#fetch', 'exact'),
           ('A#run', 'a.ts', 'd.ts', 'void()',  'd.ts::D#void',  'D#void',  'exact')`,
      );
    }

    const resolvedSql = (): { sql: string; params: unknown[] } => {
      const cte = resolvedIdentifiersCte({ sql: "TRUE", params: [] });
      return {
        sql: `${cte.sql}
          SELECT rel_path, owner_symbol_id, kind, name, line, type_name, type_source, type_multiplicity
            FROM resolved ORDER BY rel_path, owner_symbol_id, line`,
        params: cte.params,
      };
    };

    it("types the untyped locals from their call target and leaves the typed ones alone", async () => {
      await seedIdentifiers();
      const { sql, params } = resolvedSql();
      expect(await db.queryAll(sql, params)).toEqual([
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "doc",
          line: 1,
          type_name: "Doc",
          type_source: "call-return",
          type_multiplicity: "many",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "typed",
          line: 2,
          type_name: "Typed",
          type_source: "annotation",
          type_multiplicity: "one",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "item",
          line: 3,
          type_name: "Item",
          type_source: "call-return",
          type_multiplicity: "one",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "wrapped",
          line: 4,
          type_name: "Result",
          type_source: "call-return",
          type_multiplicity: "one",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "other",
          line: 5,
          type_name: "Other",
          type_source: "annotation",
          type_multiplicity: "many",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "nothing",
          line: 6,
          type_name: null,
          type_source: null,
          type_multiplicity: "one",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "promise",
          line: 7,
          type_name: "Promise",
          type_source: "call-return",
          type_multiplicity: "one",
        },
        {
          rel_path: "a.ts",
          owner_symbol_id: "A#run",
          kind: "local",
          name: "orphan",
          line: 8,
          type_name: null,
          type_source: null,
          type_multiplicity: "one",
        },
        {
          rel_path: "b.ts",
          owner_symbol_id: "B#load",
          kind: "return",
          name: "load",
          line: 1,
          type_name: "Doc",
          type_source: "annotation",
          type_multiplicity: "many",
        },
        {
          rel_path: "c.ts",
          owner_symbol_id: "C#fetch",
          kind: "return",
          name: "fetch",
          line: 1,
          type_name: "Item",
          type_source: "annotation",
          type_multiplicity: "one",
        },
      ]);
    });

    it("plans the call-target join as a hash join, never a nested loop", async () => {
      await seedIdentifiers();
      const { sql, params } = resolvedSql();
      const plan = await planOf(sql, params);
      expect(plan).toMatch(/HASH_JOIN/);
      expect(plan).not.toMatch(NESTED_LOOP_JOIN);
    });
  });

  describe("getChunkSignalsBulk — carried-over page rank join", () => {
    async function seedRanks(): Promise<void> {
      await db.run(
        `INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json)
         VALUES ('x.ts', 'S', 'S', 'S', '[]'),
                ('y.ts', 'S', 'S', 'S', '[]'),
                ('z.ts', 'T', 'T', 'T', '[]'),
                ('w.ts', 'V', 'V', 'V', '[]')`,
      );
      // `S`: a carried-over rank (rel_path '') AND a per-file rank for x.ts —
      // the per-file one wins there, y.ts keeps the carried-over value.
      // `T`: carried-over only. `U`: carried-over with no declaration.
      // `V`: per-file only.
      await db.run(
        `INSERT INTO cg_symbols_metrics (rel_path, symbol_id, page_rank)
         VALUES ('', 'S', 0.5), ('x.ts', 'S', 0.9), ('', 'T', 0.3), ('', 'U', 0.2), ('w.ts', 'V', 0.7)`,
      );
    }

    it("fans a carried-over rank out to every declaring file, and a per-file rank wins its own file", async () => {
      await seedRanks();
      const signals = await db.getChunkSignalsBulk();
      const ranks = [...signals.entries()].map(([key, s]) => [key, s.pageRank]).sort();
      expect(ranks).toEqual(
        [
          [fileScopedSymbolKey({ relPath: "w.ts", symbolId: "V" }), 0.7],
          [fileScopedSymbolKey({ relPath: "x.ts", symbolId: "S" }), 0.9],
          [fileScopedSymbolKey({ relPath: "y.ts", symbolId: "S" }), 0.5],
          [fileScopedSymbolKey({ relPath: "z.ts", symbolId: "T" }), 0.3],
        ].sort(),
      );
    });

    it("plans the declaration join as a hash join, never a nested loop", async () => {
      await seedRanks();
      // Record the SQL the reader issues, so the plan is taken of the real query.
      const issued: string[] = [];
      const recordingSession = {
        queryAll: async (sql: string, params: unknown[] = []) => {
          issued.push(sql);
          return db.queryAll(sql, params);
        },
      } as unknown as DuckDbGraphSession;
      await new DuckDbMethodEdgeReader(recordingSession).getChunkSignalsBulk();
      const pageRankSql = issued.find((sql) => sql.includes("cg_symbols_metrics"));
      expect(pageRankSql).toBeDefined();
      const plan = await planOf(pageRankSql as string);
      expect(plan).toMatch(/HASH_JOIN/);
      expect(plan).not.toMatch(NESTED_LOOP_JOIN);
    });
  });
});
