/**
 * Dead symbols never outlive their source (epic tea-rags-mcp-4p3sb).
 *
 * INVARIANT — no row outlives its source. Once a symbol, a method or a whole
 * file is gone from the working tree, the codegraph DuckDB holds no row that
 * still names it: not in `cg_symbols`, not in either edge table (as source OR
 * target), not in `cg_identifiers` (the params / locals / `return` row the dead
 * method owned), and not in the derived tables (`cg_symbols_cycles`,
 * `cg_symbols_metrics`). The reverse holds too: a file that did not change keeps
 * its rows physically untouched (same `rowid`), so the cleanup never costs churn.
 *
 * Driven through the REAL write path: `CodegraphEnrichmentProvider` over an
 * in-process DuckDB with every migration applied, walking real Ruby source. The
 * ingest half — which paths reach `handleDeletedPaths` at all — is pinned in
 * `tests/core/domains/ingest/operations/reindexing-dead-symbols.test.ts`; the
 * storage half of the dead-ROW-VERSION class in
 * `tests/core/adapters/duckdb/identifier-dead-row-reclaim.test.ts`; the fresh
 * graph a full `--force` builds in
 * `tests/core/adapters/duckdb/force-rebuild-fresh-graph.test.ts`.
 *
 * Bug history this guards:
 *  - bd tea-rags-mcp-dy852 (3e24ffa0a) — a deletion-only reindex pruned the
 *    base tables and left `cg_symbols_cycles` / `cg_symbols_metrics` as the last
 *    finalize wrote them: `find_cycles` served cycles through deleted files.
 *  - bd tea-rags-mcp-dvzdm (b53f5faf4) — the dead row VERSIONS of the same class:
 *    an indexed table never reclaims what it deletes (see the reclaim test).
 *  - bd tea-rags-mcp-a2ddb — codegraph payload in Qdrant went stale for files
 *    that stopped changing. `cg_identifiers` writes NO Qdrant payload, so that
 *    class is out of scope for this table; the last case pins that no codegraph
 *    payload descriptor is sourced from it.
 *  - epic tea-rags-mcp-4p3sb (fix 1de037af3) — found by this matrix: a method
 *    removed from a still-present file kept its INCOMING edge from an unchanged
 *    caller, and PageRank ranked the dead symbol. `upsertSymbolsBulk` now
 *    retires the method edges into every `cg_symbols` key its diff removes.
 *
 * Case table (run shape → what must be gone / kept):
 *
 * | #  | case                                   | run shape                                   |
 * | -- | -------------------------------------- | ------------------------------------------- |
 * | 1  | method removed from a live file        | incremental re-walk of the file             |
 * | 2  | file deleted                           | `handleDeletedPaths`, then next finalize    |
 * | 3  | file renamed / moved                   | delete old path + walk new path             |
 * | 4  | class renamed                          | incremental re-walk of the file             |
 * | 5  | file left with no declarations         | incremental re-walk (the `[]` path)         |
 * | 6  | unchanged file                         | re-walked alongside a changed one           |
 * | 7  | file excluded by codegraph config      | repair pass orphans it                      |
 * | 8  | every node write carries identifiers   | stream / buildFileSignals / fan-out / xpass |
 * | 9  | `--force-enrichments codegraph`        | sync-leg repair + forced repair             |
 * | 11 | worktree-seeded first index            | incremental over a cloned sibling graph     |
 *
 * Case 10 (full `--force`) lives in `force-rebuild-fresh-graph.test.ts`.
 * `.contextignore` (the other half of case 7) is an ingest decision and is
 * pinned in the reindexing test.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DuckDbGraphSession } from "../../../../../../src/core/adapters/duckdb/graph-session.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { SymbolNodeFlushQueue } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/node-flush.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ─── Fixture ────────────────────────────────────────────────────────────────
// `Alpha#doomed` is the symbol that dies. It has params and a local (its
// `cg_identifiers`), an outgoing edge (to `Beta.go`), an incoming edge from a
// file that is never re-walked (`Beta.go`), and sits on a method cycle
// `Alpha#doomed -> Beta.go -> Alpha#doomed`, so it also owns a PageRank row.

const ALPHA = "app/alpha.rb";
const BETA = "app/beta.rb";

const ALPHA_V1 = `class Alpha
  def keep(k)
    kept = k
    Beta.go(kept)
  end

  def doomed(d)
    tmp = d
    Beta.go(tmp)
  end
end
`;

const ALPHA_WITHOUT_DOOMED = `class Alpha
  def keep(k)
    kept = k
    Beta.go(kept)
  end
end
`;

const ALPHA_CLASS_RENAMED = `class Gamma
  def keep(k)
    kept = k
    Beta.go(kept)
  end

  def doomed(d)
    tmp = d
    Beta.go(tmp)
  end
end
`;

const ALPHA_NO_DECLARATIONS = `# Everything moved out of this file.
`;

const DELTA = "app/delta.rb";

const DELTA_V1 = `class Delta
  def ping(p)
    q = p
    Alpha.new.keep(q)
  end
end
`;

const BETA_V1 = `class Beta
  def self.go(n)
    Alpha.new.doomed(n)
    Alpha.new.keep(n)
  end
end
`;

// ─── Harness ────────────────────────────────────────────────────────────────

interface Harness {
  root: string;
  dbPath: string;
  client: DuckDbGraphClient;
  provider: CodegraphEnrichmentProvider;
  write: (relPath: string, source: string) => void;
  remove: (relPath: string) => void;
  /** One incremental run over `paths`: pass-1 via the run sink, then the finalize (pass-2 + derived tables). */
  incremental: (paths: string[]) => Promise<void>;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cg-dead-src-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeFile(root: string, relPath: string, source: string): void {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), source);
}

function makeProvider(
  client: DuckDbGraphClient,
  exclusion?: { customPatterns: readonly string[] },
): CodegraphEnrichmentProvider {
  return new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
    ...(exclusion ? { exclusion } : {}),
  });
}

async function openClient(dbPath: string): Promise<DuckDbGraphClient> {
  const client = new DuckDbGraphClient({ path: dbPath });
  await client.init();
  await runMigrations(client, DATABASE_MIGRATIONS);
  return client;
}

async function makeHarness(files: Record<string, string>, dbPath?: string): Promise<Harness> {
  const root = makeRoot();
  for (const [rel, src] of Object.entries(files)) writeFile(root, rel, src);
  let path = dbPath;
  if (path === undefined) {
    const dbDir = mkdtempSync(join(tmpdir(), "cg-dead-db-"));
    cleanups.push(() => {
      rmSync(dbDir, { recursive: true, force: true });
    });
    path = join(dbDir, "g.duckdb");
  }
  const client = await openClient(path);
  cleanups.push(async () => client.close());
  const provider = makeProvider(client);
  return {
    root,
    dbPath: path,
    client,
    provider,
    write: (relPath, source) => {
      writeFile(root, relPath, source);
    },
    remove: (relPath) => {
      unlinkSync(join(root, relPath));
    },
    incremental: async (paths) => {
      await provider.streamFileBatch(root, paths);
      await provider.finalizeSignals(root);
      // `CompletionRunner#buildMetrics` drains the run's resolve tally after
      // every finalize; a harness that skipped it would carry the tally into the
      // next finalize and re-persist the previous run's per-file resolve stats.
      provider.getRunMetrics();
    },
  };
}

/**
 * Every `cg_*` column that names a file, discovered from the catalog so a NEW
 * table carrying a path joins the invariant without editing this test.
 * `cg_symbol_signals_prev` / `cg_file_signals_prev` are excluded on purpose:
 * they are the baseline of what Qdrant was last HEALED to, refreshed wholesale
 * by `refreshSymbolSignalsPrev` after the payload heal (codegraph navigator), so
 * a row there for a deleted file is the diff's input, not a live graph row.
 */
const HEAL_BASELINE_TABLES = new Set(["cg_symbol_signals_prev", "cg_file_signals_prev"]);

async function pathColumns(client: DuckDbGraphClient): Promise<{ table: string; column: string }[]> {
  const rows = await client.queryAll<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM duckdb_columns()
      WHERE table_name LIKE 'cg\\_%' ESCAPE '\\' AND column_name LIKE '%rel\\_path' ESCAPE '\\'
      ORDER BY table_name, column_name`,
  );
  return rows
    .filter((r) => !HEAL_BASELINE_TABLES.has(r.table_name))
    .map((r) => ({ table: r.table_name, column: r.column_name }));
}

/** `"<table>.<column>"` for every path column still holding a row for `relPath`. Empty = the file left no trace. */
async function tablesStillNaming(client: DuckDbGraphClient, relPath: string): Promise<string[]> {
  const hits: string[] = [];
  for (const { table, column } of await pathColumns(client)) {
    const [row] = await client.queryAll<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`,
      [relPath],
    );
    if (Number(row?.n ?? 0) > 0) hits.push(`${table}.${column}`);
  }
  // File-scope cycle members are paths stored in `member`, not a *_rel_path column.
  const [fileCycle] = await client.queryAll<{ n: number | bigint }>(
    "SELECT count(*) AS n FROM cg_symbols_cycles WHERE scope = 'file' AND member = ?",
    [relPath],
  );
  if (Number(fileCycle?.n ?? 0) > 0) hits.push("cg_symbols_cycles.member");
  return hits;
}

/** Every row, in every table, that names the symbol `symbolId` declared in `relPath`. */
async function rowsNamingSymbol(client: DuckDbGraphClient, relPath: string, symbolId: string): Promise<string[]> {
  const queries: [string, string, unknown[]][] = [
    ["cg_symbols", "SELECT count(*) AS n FROM cg_symbols WHERE rel_path = ? AND symbol_id = ?", [relPath, symbolId]],
    [
      "cg_symbols_edges_method(source)",
      "SELECT count(*) AS n FROM cg_symbols_edges_method WHERE source_rel_path = ? AND source_symbol_id = ?",
      [relPath, symbolId],
    ],
    [
      "cg_symbols_edges_method(target)",
      "SELECT count(*) AS n FROM cg_symbols_edges_method WHERE target_rel_path = ? AND target_symbol_id = ?",
      [relPath, symbolId],
    ],
    [
      "cg_identifiers",
      "SELECT count(*) AS n FROM cg_identifiers WHERE rel_path = ? AND owner_symbol_id = ?",
      [relPath, symbolId],
    ],
    [
      "cg_symbols_metrics",
      "SELECT count(*) AS n FROM cg_symbols_metrics WHERE rel_path = ? AND symbol_id = ?",
      [relPath, symbolId],
    ],
    [
      "cg_symbols_cycles",
      "SELECT count(*) AS n FROM cg_symbols_cycles WHERE scope = 'method' AND member_rel_path = ? AND member = ?",
      [relPath, symbolId],
    ],
  ];
  const hits: string[] = [];
  for (const [label, sql, params] of queries) {
    const [row] = await client.queryAll<{ n: number | bigint }>(sql, params);
    if (Number(row?.n ?? 0) > 0) hits.push(label);
  }
  return hits;
}

async function symbolIds(client: DuckDbGraphClient, relPath: string): Promise<string[]> {
  const rows = await client.queryAll<{ symbol_id: string }>(
    "SELECT symbol_id FROM cg_symbols WHERE rel_path = ? ORDER BY symbol_id",
    [relPath],
  );
  return rows.map((r) => r.symbol_id);
}

async function identifierOwners(client: DuckDbGraphClient, relPath: string): Promise<string[]> {
  const rows = await client.queryAll<{ o: string }>(
    "SELECT DISTINCT owner_symbol_id AS o FROM cg_identifiers WHERE rel_path = ? ORDER BY o",
    [relPath],
  );
  return rows.map((r) => r.o);
}

/**
 * `table:rowid` for every row a file owns in the KEYED tables a re-walk writes,
 * so a rewrite is visible. DuckDB assigns a fresh rowid to an appended row;
 * `cg_identifiers` is left out because it has no index, so the checkpoint
 * vacuums its deletes and renumbers the rows behind them.
 */
async function rowIdsOwnedBy(client: DuckDbGraphClient, relPath: string): Promise<string[]> {
  const owned: [string, string][] = [
    ["cg_symbols", "rel_path"],
    ["cg_symbols_edges_method", "source_rel_path"],
    ["cg_symbols_edges_file", "source_rel_path"],
    ["cg_symbols_files", "rel_path"],
    ["cg_file_resolve_stats", "rel_path"],
  ];
  const ids: string[] = [];
  for (const [table, column] of owned) {
    const rows = await client.queryAll<{ rowid: number | bigint | string }>(
      `SELECT rowid FROM ${table} WHERE ${column} = ? ORDER BY rowid`,
      [relPath],
    );
    for (const r of rows) ids.push(`${table}:${String(r.rowid)}`);
  }
  return ids;
}

/** The rel_paths each `cg_identifiers` DELETE / INSERT statement named, from the spy on. */
function spyIdentifierWrites(): { deleted: string[]; inserted: string[] } {
  const seen = { deleted: [] as string[], inserted: [] as string[] };
  const { run } = DuckDbGraphSession.prototype;
  vi.spyOn(DuckDbGraphSession.prototype, "run").mockImplementation(async function (
    this: DuckDbGraphSession,
    sql: string,
    params: unknown[] = [],
  ) {
    if (/^DELETE FROM cg_identifiers\b/.test(sql)) seen.deleted.push(...params.map(String));
    return run.call(this, sql, params);
  });
  const { insertBatched } = DuckDbGraphSession.prototype;
  vi.spyOn(DuckDbGraphSession.prototype, "insertBatched").mockImplementation(async function (
    this: DuckDbGraphSession,
    ...args: Parameters<DuckDbGraphSession["insertBatched"]>
  ) {
    const [table, , rows] = args;
    if (table === "cg_identifiers") seen.inserted.push(...rows.map((r) => String(r[0])));
    return insertBatched.apply(this, args);
  });
  return seen;
}

/** The precondition every case starts from: the dead-to-be symbol is present in every table. */
async function expectDoomedFullyPresent(client: DuckDbGraphClient): Promise<void> {
  expect(await rowsNamingSymbol(client, ALPHA, "Alpha#doomed")).toEqual([
    "cg_symbols",
    "cg_symbols_edges_method(source)",
    "cg_symbols_edges_method(target)",
    "cg_identifiers",
    "cg_symbols_metrics",
    "cg_symbols_cycles",
  ]);
}

async function seededHarness(): Promise<Harness> {
  const h = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1 });
  await h.incremental([ALPHA, BETA]);
  await expectDoomedFullyPresent(h.client);
  return h;
}

// ─── Cases ──────────────────────────────────────────────────────────────────

describe("dead symbols never outlive their source — codegraph provider over a real DuckDB", () => {
  it("case 1: a method removed from a still-present file leaves no symbol row, edge in or out, identifier, rank or cycle", async () => {
    const h = await seededHarness();

    h.write(ALPHA, ALPHA_WITHOUT_DOOMED);
    await h.incremental([ALPHA]); // BETA is unchanged and NOT re-walked — its call into doomed dangles in source.

    expect(await rowsNamingSymbol(h.client, ALPHA, "Alpha#doomed")).toEqual([]);
    expect(await symbolIds(h.client, ALPHA)).toEqual(["Alpha", "Alpha#keep"]);
    expect(await identifierOwners(h.client, ALPHA)).toEqual(["Alpha#keep"]);
    // The survivor keeps its own incoming edge from the unchanged caller.
    expect(await rowsNamingSymbol(h.client, ALPHA, "Alpha#keep")).toContain("cg_symbols_edges_method(target)");
  });

  it("case 2: a deleted file leaves no row in any cg_* table, derived tables included", async () => {
    const h = await seededHarness();

    h.remove(ALPHA);
    await h.provider.handleDeletedPaths([ALPHA]);

    // A deletion-only run: pruned at once, derived tables marked stale (dy852).
    expect(await tablesStillNaming(h.client, ALPHA)).toEqual([]);
    expect(await h.provider.hasStaleDerivedState()).toBe(true);

    // The next run's finalize recomputes the derived tables — still nothing.
    await h.provider.finalizeSignals(h.root);
    h.provider.getRunMetrics();
    expect(await tablesStillNaming(h.client, ALPHA)).toEqual([]);
    expect(await h.provider.hasStaleDerivedState()).toBe(false);
  });

  it("case 3: a renamed file leaves nothing under the old path and everything under the new one", async () => {
    const h = await seededHarness();
    const moved = "lib/alpha.rb";

    h.remove(ALPHA);
    h.write(moved, ALPHA_V1);
    // Ingest sees a rename as `deleted` + `added`: the old path reaches the
    // deletion hook, the new one the walk.
    await h.provider.handleDeletedPaths([ALPHA]);
    await h.incremental([moved]);

    expect(await tablesStillNaming(h.client, ALPHA)).toEqual([]);
    expect(await symbolIds(h.client, moved)).toEqual(["Alpha", "Alpha#doomed", "Alpha#keep"]);
    expect(await identifierOwners(h.client, moved)).toEqual(["Alpha#doomed", "Alpha#keep"]);
  });

  it("case 4: a renamed class leaves none of its old symbolIds anywhere, identifiers of its old methods included", async () => {
    const h = await seededHarness();

    h.write(ALPHA, ALPHA_CLASS_RENAMED);
    await h.incremental([ALPHA]);

    for (const dead of ["Alpha", "Alpha#keep", "Alpha#doomed"]) {
      expect({ dead, rows: await rowsNamingSymbol(h.client, ALPHA, dead) }).toEqual({ dead, rows: [] });
    }
    expect(await symbolIds(h.client, ALPHA)).toEqual(["Gamma", "Gamma#doomed", "Gamma#keep"]);
    expect(await identifierOwners(h.client, ALPHA)).toEqual(["Gamma#doomed", "Gamma#keep"]);
  });

  it("case 5: a file edited down to no declarations keeps no symbol, identifier or incoming edge", async () => {
    const h = await seededHarness();

    h.write(ALPHA, ALPHA_NO_DECLARATIONS);
    await h.incremental([ALPHA]);

    expect(await symbolIds(h.client, ALPHA)).toEqual([]);
    // The `[]` identifier entry clears the file (node-flush: `[]` clears, `undefined` leaves alone).
    expect(await identifierOwners(h.client, ALPHA)).toEqual([]);
    const [incoming] = await h.client.queryAll<{ n: number | bigint }>(
      "SELECT count(*) AS n FROM cg_symbols_edges_method WHERE target_rel_path = ? AND target_symbol_id IS NOT NULL",
      [ALPHA],
    );
    expect(Number(incoming?.n)).toBe(0);
    for (const dead of ["Alpha#keep", "Alpha#doomed"]) {
      expect({ dead, rows: await rowsNamingSymbol(h.client, ALPHA, dead) }).toEqual({ dead, rows: [] });
    }
  });

  it("case 6: an unchanged file re-walked next to a changed one keeps every row it owns physically untouched", async () => {
    // DELTA calls only the survivor, so nothing about its resolution depends on
    // the change — every row it owns must come through the run untouched.
    const h = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1, [DELTA]: DELTA_V1 });
    await h.incremental([ALPHA, BETA, DELTA]);
    const deltaBefore = await rowIdsOwnedBy(h.client, DELTA);
    expect(deltaBefore.some((id) => id.startsWith("cg_symbols:"))).toBe(true);
    expect(await identifierOwners(h.client, DELTA)).toEqual(["Delta#ping"]);
    const identifierWrites = spyIdentifierWrites();

    h.write(ALPHA, ALPHA_WITHOUT_DOOMED);
    // DELTA's source is identical; it is re-walked anyway, as a forced repair
    // or a recompute re-walks unchanged files.
    await h.incremental([ALPHA, DELTA]);

    // Same rowids = never deleted and re-inserted, in every KEYED table.
    expect(await rowIdsOwnedBy(h.client, DELTA)).toEqual(deltaBefore);
    // `cg_identifiers` has no key and its deletes are vacuumed at checkpoint,
    // which renumbers rowids — so the statements are the observation there: the
    // unchanged file is neither deleted nor re-inserted, the changed one is.
    expect(identifierWrites.deleted).not.toContain(DELTA);
    expect(identifierWrites.inserted).not.toContain(DELTA);
    expect(identifierWrites.deleted).toContain(ALPHA);
    expect(await identifierOwners(h.client, DELTA)).toEqual(["Delta#ping"]);
  });

  it("case 7: a file the codegraph exclusion config starts excluding is orphaned by the repair pass and leaves no row", async () => {
    const h = await seededHarness();
    // Same tree, same DuckDB — only the codegraph exclusion config changed.
    const excluding = makeProvider(h.client, { customPatterns: ["app/alpha.rb"] });
    const coordinator = new EnrichmentCoordinator({} as never, excluding, undefined, new InlineEnrichmentExecutor());

    await coordinator.runRepairPass(
      "code_dead_v1" as never,
      h.root,
      new Map([
        [ALPHA, "h-alpha"],
        [BETA, "h-beta"],
      ]),
    );
    await excluding.finalizeSignals(h.root, { collectionName: "code_dead_v1" as never });
    excluding.getRunMetrics();

    expect(await tablesStillNaming(h.client, ALPHA)).toEqual([]);
  });

  describe("case 8: every path that writes a file's symbols also writes its identifiers", () => {
    // `SymbolNodeFlushQueue#buffer` leaves `cg_identifiers` alone when its
    // `identifiers` argument is omitted, so a caller that forgot it would keep a
    // file's old identifiers next to its new symbols. Every entry point into the
    // node write is driven here and each buffered call must carry the list.
    function spyBuffer() {
      return vi.spyOn(SymbolNodeFlushQueue.prototype, "buffer");
    }

    function expectEveryCallCarriesIdentifiers(spy: ReturnType<typeof spyBuffer>, relPaths: string[]): void {
      const buffered = spy.mock.calls.map((c) => ({ relPath: c[0], identifiers: Array.isArray(c[4]) }));
      expect(buffered.map((b) => b.relPath).sort()).toEqual([...relPaths].sort());
      expect(buffered.every((b) => b.identifiers)).toBe(true);
    }

    it("the incremental run sink (streamFileBatch)", async () => {
      const h = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1 });
      const spy = spyBuffer();
      await h.incremental([ALPHA, BETA]);
      expectEveryCallCarriesIdentifiers(spy, [ALPHA, BETA]);
    });

    it("the whole-pass walk (buildFileSignals)", async () => {
      const h = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1 });
      const spy = spyBuffer();
      await h.provider.buildFileSignals(h.root, { paths: [ALPHA, BETA] });
      expectEveryCallCarriesIdentifiers(spy, [ALPHA, BETA]);
    });

    it("the pass-1 fan-out (extractFileBatch + absorbExtractedFiles)", async () => {
      const h = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1 });
      const spy = spyBuffer();
      const { extractions } = await h.provider.extractFileBatch(h.root, [ALPHA, BETA]);
      await h.provider.absorbExtractedFiles(h.root, extractions);
      await h.provider.finalizeSignals(h.root);
      expectEveryCallCarriesIdentifiers(spy, [ALPHA, BETA]);
    });

    it("the cross-pass main-thread tee (acceptExtraction)", async () => {
      const h = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1 });
      const { extractions } = await h.provider.extractFileBatch(h.root, [ALPHA, BETA]);
      const collectionName = "code_dead_xpass" as never;
      const spy = spyBuffer();
      h.provider.beginExtractionRun(collectionName);
      for (const extraction of extractions) h.provider.acceptExtraction(extraction, { collectionName });
      expectEveryCallCarriesIdentifiers(spy, [ALPHA, BETA]);
    });

    it("and the carried list is what clears a dead method's identifiers on re-walk", async () => {
      const h = await seededHarness();
      h.write(ALPHA, ALPHA_WITHOUT_DOOMED);
      const { extractions } = await h.provider.extractFileBatch(h.root, [ALPHA]);
      await h.provider.absorbExtractedFiles(h.root, extractions);
      await h.provider.finalizeSignals(h.root);
      expect(await identifierOwners(h.client, ALPHA)).toEqual(["Alpha#keep"]);
    });
  });

  it("case 9: --force-enrichments codegraph — the sync-leg repair prunes a file gone since the last run, the forced repair retires a dead method", async () => {
    const h = await makeHarness({
      [ALPHA]: ALPHA_V1,
      [BETA]: BETA_V1,
      "app/gone.rb": "class Gone\n  def x(y)\n  end\nend\n",
    });
    await h.incremental([ALPHA, BETA, "app/gone.rb"]);
    expect(await symbolIds(h.client, "app/gone.rb")).toEqual(["Gone", "Gone#x"]);

    // Between runs: a file vanished without any run observing it (deleted
    // while no index ran), and a method left a still-present file.
    h.remove("app/gone.rb");
    h.write(ALPHA, ALPHA_WITHOUT_DOOMED);
    const scanned = new Map([
      [ALPHA, "h-alpha-2"],
      [BETA, "h-beta"],
    ]);
    const coordinator = new EnrichmentCoordinator({} as never, h.provider, undefined, new InlineEnrichmentExecutor());

    // `IndexingOps#recomputeEnrichments` = the sync leg (an ordinary incremental,
    // whose drift repair prunes orphans) followed by the selector-forced repair
    // (re-walks every eligible file, never prunes).
    await coordinator.runRepairPass("code_dead_v1" as never, h.root, scanned);
    await coordinator.runRepairPass("code_dead_v1" as never, h.root, scanned, undefined, new Set([h.provider.key]));
    await h.provider.finalizeSignals(h.root, { collectionName: "code_dead_v1" as never });
    h.provider.getRunMetrics();

    expect(await tablesStillNaming(h.client, "app/gone.rb")).toEqual([]);
    expect(await rowsNamingSymbol(h.client, ALPHA, "Alpha#doomed")).toEqual([]);
    expect(await symbolIds(h.client, BETA)).toEqual(["Beta", "Beta.go"]);
  });

  it("case 11: a worktree-seeded first index drops a method the worktree removed and a file it deleted", async () => {
    // The sibling's graph, as `CodegraphDbFiles#cloneDatabase` hands it to the
    // worktree: a byte copy of the sibling's DuckDB file (and its WAL).
    const sibling = await makeHarness({ [ALPHA]: ALPHA_V1, [BETA]: BETA_V1, [DELTA]: DELTA_V1 });
    await sibling.incremental([ALPHA, BETA, DELTA]);
    await sibling.client.close();
    const seedDir = mkdtempSync(join(tmpdir(), "cg-dead-seed-"));
    cleanups.push(() => {
      rmSync(seedDir, { recursive: true, force: true });
    });
    const seededPath = join(seedDir, "worktree.duckdb");
    copyFileSync(sibling.dbPath, seededPath);
    // A pooled close never checkpoints, so the WAL is half the database — the
    // clone copies it too.
    if (existsSync(`${sibling.dbPath}.wal`)) copyFileSync(`${sibling.dbPath}.wal`, `${seededPath}.wal`);

    // The worktree's tree differs from the sibling's: doomed is gone, and DELTA
    // was deleted on the branch.
    const worktree = await makeHarness({ [ALPHA]: ALPHA_WITHOUT_DOOMED, [BETA]: BETA_V1 }, seededPath);
    await expectDoomedFullyPresent(worktree.client); // the seed carried both over
    expect(await symbolIds(worktree.client, DELTA)).toEqual(["Delta", "Delta#ping"]);

    // The first incremental over the seed diffs the tree against the CLONED
    // snapshot, which still holds the sibling's hashes: ALPHA is `modified`,
    // DELTA `deleted`.
    await worktree.provider.handleDeletedPaths([DELTA]);
    await worktree.incremental([ALPHA]);

    expect(await rowsNamingSymbol(worktree.client, ALPHA, "Alpha#doomed")).toEqual([]);
    expect(await identifierOwners(worktree.client, ALPHA)).toEqual(["Alpha#keep"]);
    expect(await tablesStillNaming(worktree.client, DELTA)).toEqual([]);
  });

  it("cg_identifiers feeds no Qdrant payload, so the stale-payload class (a2ddb) cannot reach it", () => {
    const h = makeProvider({} as never);
    const keys = h.signals.map((s) => s.key);
    expect(keys.filter((k) => /identifier|lexicon|naming/i.test(k))).toEqual([]);
  });
});
