/**
 * Fixture for the working-tree graph tests: a BASE TypeScript project indexed
 * through the real direct-mode provider into a self-contained snapshot file
 * (CHECKPOINTed, every client closed, no WAL), and a TREE directory that starts
 * as a byte copy of the base project and is then edited — the shape a real
 * working tree has against the commit its index saw.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fixturePhysicalCollectionName } from "../../../../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../../../../src/core/adapters/duckdb/client.js";
import type { PhysicalCollectionName } from "../../../../../../../src/core/contracts/types/collection-identity.js";
import { createCodegraphProviderRuntime } from "../../../../../../../src/core/domains/trajectory/codegraph/factory.js";

/** Compiled barrels the factory dynamic-imports — the same paths production hands it. */
export const LANGUAGE_MODULE_PATH = new URL(
  "../../../../../../../build/core/domains/language/index.js",
  import.meta.url,
).pathname;
export const MIGRATIONS_MODULE_PATH = new URL(
  "../../../../../../../build/core/domains/maintenance/migration/database/index.js",
  import.meta.url,
).pathname;

export const PHYSICAL: PhysicalCollectionName = fixturePhysicalCollectionName("code_wtgraph_v1");

export interface TreeGraphFixture {
  /** The base project the snapshot was built from. */
  baseRoot: string;
  /** The working tree: a copy of `baseRoot`, edited by the test. */
  treeRoot: string;
  /** Self-contained base graph (no WAL). */
  snapshotPath: string;
  /** A fresh staging dir the build may write under. */
  outputRoot: string;
  writeTree: (relPath: string, source: string) => void;
  removeTree: (relPath: string) => void;
}

const tempDirs: string[] = [];

export function cleanupTreeGraphFixtures(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, source: string): void {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), source);
}

/**
 * Index `files` as the base and leave the result as one self-contained file.
 * Content hashes are stamped the way the ingest pipeline stamps them, so the
 * only NULL hashes in the snapshot are the ones a later deletion writes.
 */
export async function buildTreeGraphFixture(files: Record<string, string>): Promise<TreeGraphFixture> {
  const baseRoot = tempDir("wtg-base-src-");
  const treeRoot = tempDir("wtg-tree-src-");
  const storageRoot = tempDir("wtg-base-db-");
  for (const [rel, src] of Object.entries(files)) {
    writeFile(baseRoot, rel, src);
    writeFile(treeRoot, rel, src);
  }
  const contentHashes = new Map(
    Object.entries(files).map(([rel, src]) => [rel, createHash("sha256").update(src).digest("hex")]),
  );
  const { provider, pool } = await createCodegraphProviderRuntime({
    languageModulePath: LANGUAGE_MODULE_PATH,
    migrationsModulePath: MIGRATIONS_MODULE_PATH,
    rootDir: storageRoot,
    collectionName: PHYSICAL,
  });
  try {
    await provider.buildFileSignals(baseRoot, {
      paths: Object.keys(files),
      collectionName: PHYSICAL,
      contentHashes,
    });
    await (await pool.acquire(PHYSICAL)).graphDb.checkpoint();
  } finally {
    await pool.closeAll();
  }
  const snapshotPath = pool.pathFor(PHYSICAL);
  const wal = `${snapshotPath}.wal`;
  if (existsSync(wal)) {
    if (statSync(wal).size > 0) throw new Error(`fixture snapshot left a non-empty WAL at ${wal}`);
    unlinkSync(wal);
  }
  return {
    baseRoot,
    treeRoot,
    snapshotPath,
    outputRoot: tempDir("wtg-out-"),
    writeTree: (relPath, source) => {
      writeFile(treeRoot, relPath, source);
    },
    removeTree: (relPath) => {
      unlinkSync(join(treeRoot, relPath));
    },
  };
}

/** Run `fn` against a READ_ONLY client on `dbPath`, closing it afterwards. */
export async function withReadOnlyGraph<T>(dbPath: string, fn: (client: DuckDbGraphClient) => Promise<T>): Promise<T> {
  const client = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
  await client.init();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Every method edge as `source_rel_path#source_symbol_id -> target_rel_path#target_symbol_id`, sorted. */
export async function methodEdges(dbPath: string): Promise<string[]> {
  return withReadOnlyGraph(dbPath, async (client) => {
    const rows = await client.queryAll<{ s: string; t: string }>(
      `SELECT source_rel_path || '#' || source_symbol_id AS s,
              coalesce(target_rel_path, '?') || '#' || coalesce(target_symbol_id, '<file>') AS t
         FROM cg_symbols_edges_method`,
    );
    return rows.map((r) => `${r.s} -> ${r.t}`).sort();
  });
}

/** Full rows (as stable JSON) of the method edges `source_rel_path = relPath` carries. */
export async function methodEdgeRowsFrom(dbPath: string, relPath: string): Promise<string[]> {
  return withReadOnlyGraph(dbPath, async (client) => {
    const rows = await client.queryAll<Record<string, unknown>>(
      "SELECT * FROM cg_symbols_edges_method WHERE source_rel_path = ?",
      [relPath],
    );
    return rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => !key.endsWith("_at"))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
          ),
        ),
      )
      .sort();
  });
}

/** `rel_path#symbol_id` of every `cg_symbols` row, sorted. */
export async function symbolKeys(dbPath: string): Promise<string[]> {
  return withReadOnlyGraph(dbPath, async (client) => {
    const rows = await client.queryAll<{ k: string }>("SELECT rel_path || '#' || symbol_id AS k FROM cg_symbols");
    return rows.map((r) => r.k).sort();
  });
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
