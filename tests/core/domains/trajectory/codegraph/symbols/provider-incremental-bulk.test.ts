/**
 * Node-write unification — the INCREMENTAL (`reindex_changes`) path routes its
 * durable `cg_symbols` write through the SAME buffered-bulk mechanism as the
 * cross-pass path (`nodeDefBuffer` → `chainNodeFlush` → `flushNodeBatch` →
 * `upsertSymbolsBulk`), instead of the former per-file `graphDb.upsertSymbols`.
 *
 * Invariants under test:
 *   1. Bulk, not per-file — an incremental run issues `upsertSymbolsBulk` and
 *      ZERO per-file `upsertSymbols`.
 *   2. Graph-equality — the rows the provider bulk-writes, replayed per-file into
 *      a reference client, yield byte-identical `cg_symbols` (the two write
 *      shapes agree for the provider's real defs).
 *   3. In-memory `symbolTable.upsertFile` still runs per-file, unconditionally
 *      (the resolver's source of truth is untouched).
 *   4. A mid-incremental flush failure rethrows at `finalizeSignals` (aborts the
 *      run cleanly; no Node-≥22 unhandled rejection).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { BulkSymbolUpsertEntry } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
});

/** Materialise a temp repo with the given `relPath -> source` files. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cg-incr-"));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Fresh temp DuckDB graph client with migrations applied. */
async function makeClient(): Promise<DuckDbGraphClient> {
  const tmp = mkdtempSync(join(tmpdir(), "cg-incr-db-"));
  const client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  cleanups.push(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  return client;
}

function makeProvider(client: DuckDbGraphClient, symbolTable = new InMemoryGlobalSymbolTable()) {
  return new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable,
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
}

const TWO_FILES: Record<string, string> = {
  "src/a.ts": "export function a(): number { return 1; }\n",
  "src/b.ts": 'import { a } from "./a.js";\nexport function b(): number { return a(); }\n',
};

describe("CodegraphEnrichmentProvider — incremental node-write unification", () => {
  it("writes cg_symbols via BULK, never per-file upsertSymbols", async () => {
    const client = await makeClient();
    const perFileSpy = vi.spyOn(client, "upsertSymbols");
    const bulkSpy = vi.spyOn(client, "upsertSymbolsBulk");
    const provider = makeProvider(client);
    const root = makeRepo(TWO_FILES);

    await provider.streamFileBatch(root, ["src/a.ts"]);
    await provider.streamFileBatch(root, ["src/b.ts"]);
    await provider.finalizeSignals(root);

    const rows = await client.queryAll("SELECT rel_path, symbol_id FROM cg_symbols ORDER BY rel_path, symbol_id");
    expect(rows.length).toBeGreaterThan(0);
    expect(perFileSpy).not.toHaveBeenCalled();
    expect(bulkSpy).toHaveBeenCalled();
  });

  it("graph-equality: bulk-written rows == the same defs replayed per-file", async () => {
    const client = await makeClient();
    const bulkSpy = vi.spyOn(client, "upsertSymbolsBulk");
    const provider = makeProvider(client);
    const root = makeRepo(TWO_FILES);

    await provider.streamFileBatch(root, ["src/a.ts", "src/b.ts"]);
    await provider.finalizeSignals(root);

    // Capture every entry the provider bulk-wrote across all flushes.
    const captured: BulkSymbolUpsertEntry[] = bulkSpy.mock.calls.flatMap((c) => c[0]);
    expect(captured.length).toBeGreaterThan(0);

    // Reference: replay those exact entries through the LEGACY per-file path.
    const ref = await makeClient();
    for (const entry of captured) await ref.upsertSymbols(entry.relPath, entry.definitions);

    const subjectRows = await client.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
    const refRows = await ref.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
    expect(subjectRows).toEqual(refRows);
  });

  it("in-memory symbolTable.upsertFile still runs once per streamed file", async () => {
    const client = await makeClient();
    const symbolTable = new InMemoryGlobalSymbolTable();
    const upsertFileSpy = vi.spyOn(symbolTable, "upsertFile");
    const provider = makeProvider(client, symbolTable);
    const root = makeRepo(TWO_FILES);

    await provider.streamFileBatch(root, ["src/a.ts"]);
    await provider.streamFileBatch(root, ["src/b.ts"]);
    await provider.finalizeSignals(root);

    // One in-memory upsert per file — the resolver's source of truth is
    // unconditional, regardless of the deferred durable bulk write.
    expect(upsertFileSpy).toHaveBeenCalledTimes(2);
  });

  it("a rejecting mid-incremental flush rethrows at finalizeSignals", async () => {
    const client = await makeClient();
    const boom = new Error("bulk flush boom");
    vi.spyOn(client, "upsertSymbolsBulk").mockRejectedValue(boom);
    const provider = makeProvider(client);
    const root = makeRepo(TWO_FILES);

    // The per-batch flush latches the rejection; finalize awaits the chain and
    // rethrows it — the run aborts cleanly (no unhandled rejection).
    await provider.streamFileBatch(root, ["src/a.ts", "src/b.ts"]);
    await expect(provider.finalizeSignals(root)).rejects.toThrow("bulk flush boom");
  });
});
