/**
 * Cross-collection isolation tests for `GraphDbClientPool`.
 *
 * Pins the contract spec'd in
 * `docs/superpowers/specs/2026-04-25-codegraph-symbols-vertical-slice.md`:
 * each Qdrant collection gets its own
 * `<dataDir>/codegraph/<collectionName>.duckdb` file. Edges from
 * project A and project B can NEVER collide on PK because they live in
 * separate DuckDB instances. Concurrent first-callers for the same
 * collection share a single init pass (no duplicate migrations).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("GraphDbClientPool — per-collection isolation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pool-iso-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lazily opens per-collection files under <rootDir>/codegraph/", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    // No file exists yet — peek() returns nothing. The pool created
    // the `.spill/` directory at construction (slice 2 stale-spill
    // cleanup) but no per-collection .duckdb files yet.
    expect(pool.peek("alpha")).toBeUndefined();
    expect(readdirSync(join(tmp, "codegraph"))).toEqual([".spill"]);

    // First acquire creates the file + runs migrations.
    const a = await pool.acquire("alpha");
    expect(a.graphDb).toBeDefined();
    expect(existsSync(pool.pathFor("alpha"))).toBe(true);
    expect(readdirSync(join(tmp, "codegraph"))).toContain("alpha.duckdb");

    await pool.closeAll();
  });

  it("isolates writes between two collections (no PK collision on same relPath)", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const alpha = await pool.acquire("project-alpha");
    const beta = await pool.acquire("project-beta");

    // Same relPath in both projects — would collide under a shared DB
    // because cg_symbols_files PK is just (rel_path). With per-collection
    // DBs the same key lives in both stores independently.
    await alpha.graphDb.upsertFile(
      { relPath: "README.md", language: "markdown" },
      { fileEdges: [{ targetRelPath: "alpha-only.ts", importText: "./alpha-only" }], methodEdges: [] },
    );
    await beta.graphDb.upsertFile(
      { relPath: "README.md", language: "markdown" },
      { fileEdges: [{ targetRelPath: "beta-only.ts", importText: "./beta-only" }], methodEdges: [] },
    );

    const alphaFanOut = await alpha.graphDb.getFanOut("README.md");
    const betaFanOut = await beta.graphDb.getFanOut("README.md");
    expect(alphaFanOut).toBe(1);
    expect(betaFanOut).toBe(1);

    // Each collection sees only its own edge target. If isolation
    // failed (shared file or merged tables), one of these checks
    // would find 2 callers or the wrong path.
    const alphaCallers = await alpha.graphDb.queryAll<{ target_rel_path: string }>(
      "SELECT target_rel_path FROM cg_symbols_edges_file",
    );
    const betaCallers = await beta.graphDb.queryAll<{ target_rel_path: string }>(
      "SELECT target_rel_path FROM cg_symbols_edges_file",
    );
    expect(alphaCallers.map((r) => r.target_rel_path)).toEqual(["alpha-only.ts"]);
    expect(betaCallers.map((r) => r.target_rel_path)).toEqual(["beta-only.ts"]);

    await pool.closeAll();
  });

  it("isolates symbol tables between collections", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const alpha = await pool.acquire("alpha");
    const beta = await pool.acquire("beta");

    expect(alpha.symbolTable).not.toBe(beta.symbolTable);

    alpha.symbolTable.upsertFile("src/util.ts", [
      { symbolId: "AlphaUtil", fqName: "AlphaUtil", shortName: "AlphaUtil", relPath: "src/util.ts", scope: [] },
    ]);
    beta.symbolTable.upsertFile("src/util.ts", [
      { symbolId: "BetaUtil", fqName: "BetaUtil", shortName: "BetaUtil", relPath: "src/util.ts", scope: [] },
    ]);

    expect(alpha.symbolTable.lookupByShortName("AlphaUtil")).toHaveLength(1);
    expect(alpha.symbolTable.lookupByShortName("BetaUtil")).toHaveLength(0);
    expect(beta.symbolTable.lookupByShortName("BetaUtil")).toHaveLength(1);
    expect(beta.symbolTable.lookupByShortName("AlphaUtil")).toHaveLength(0);

    await pool.closeAll();
  });

  it("caches the handle so two acquire calls return the same instance", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const first = await pool.acquire("alpha");
    const second = await pool.acquire("alpha");
    expect(first.graphDb).toBe(second.graphDb);
    expect(first.symbolTable).toBe(second.symbolTable);
    expect(pool.peek("alpha")).toBe(first);

    await pool.closeAll();
  });

  it("shares one init pass across concurrent first-callers (no duplicate migration)", async () => {
    let initHookInvocations = 0;
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      initHook: async () => {
        initHookInvocations++;
      },
    });

    // Three concurrent acquires for the same collection name.
    const [a, b, c] = await Promise.all([pool.acquire("alpha"), pool.acquire("alpha"), pool.acquire("alpha")]);
    // All three got the same handle and the init hook only fired once.
    expect(a.graphDb).toBe(b.graphDb);
    expect(b.graphDb).toBe(c.graphDb);
    expect(initHookInvocations).toBe(1);

    await pool.closeAll();
  });

  it("release closes the cached entry and lets the next acquire reopen it", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const first = await pool.acquire("alpha");
    expect(await pool.release("alpha")).toBe(true);
    expect(pool.peek("alpha")).toBeUndefined();
    // release of a never-opened collection is a no-op.
    expect(await pool.release("never")).toBe(false);

    const second = await pool.acquire("alpha");
    // Same file, but a fresh client instance.
    expect(second.graphDb).not.toBe(first.graphDb);

    await pool.closeAll();
  });

  it("sanitises unsafe characters in collection names", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    // Names containing path separators or wildcards are not allowed
    // to escape the codegraph dir.
    const path = pool.pathFor("../etc/passwd");
    expect(path.endsWith("codegraph/.._etc_passwd.duckdb")).toBe(true);
  });

  it("removeCollection deletes the on-disk file and evicts the cached client", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    await pool.acquire("alpha");
    const dbPath = pool.pathFor("alpha");
    expect(existsSync(dbPath)).toBe(true);

    const evicted = await pool.removeCollection("alpha");
    expect(evicted).toBe(true);
    expect(pool.peek("alpha")).toBeUndefined();
    expect(existsSync(dbPath)).toBe(false);
  });

  it("removeCollection is idempotent — calling on an unknown collection is a no-op", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    // Never acquired — no cached entry, no file on disk. Must not throw.
    const evicted = await pool.removeCollection("never-opened");
    expect(evicted).toBe(false);
    expect(existsSync(pool.pathFor("never-opened"))).toBe(false);

    // Double-remove of a previously-opened collection also stays quiet.
    await pool.acquire("alpha");
    await pool.removeCollection("alpha");
    const secondEvict = await pool.removeCollection("alpha");
    expect(secondEvict).toBe(false);
  });

  it("release() evicts a cached client and returns true, false the second time", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    await pool.acquire("alpha");
    expect(pool.peek("alpha")).toBeDefined();
    const evicted = await pool.release("alpha");
    expect(evicted).toBe(true);
    expect(pool.peek("alpha")).toBeUndefined();
    // Second release on a now-empty slot is a no-op.
    expect(await pool.release("alpha")).toBe(false);
  });

  it("initHook is invoked with the acquired handle", async () => {
    const seen: string[] = [];
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      initHook: async ({ collectionName }) => {
        seen.push(collectionName);
      },
    });
    await pool.acquire("alpha");
    await pool.acquire("alpha"); // cached — no second hook call
    expect(seen).toEqual(["alpha"]);
    await pool.closeAll();
  });

  it("initHook throwing is non-fatal — pool still returns a usable handle and logs to stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      initHook: async () => {
        throw new Error("hydration failed");
      },
    });
    const handle = await pool.acquire("alpha");
    expect(handle.graphDb).toBeDefined();
    expect(handle.symbolTable).toBeDefined();
    // stderr captures the init-hook failure message
    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(messages).toContain("init-hook failed");
    expect(messages).toContain("hydration failed");
    stderrSpy.mockRestore();
    await pool.closeAll();
  });

  it("removeCollection followed by acquire produces a clean state (new file, fresh client)", async () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const first = await pool.acquire("alpha");
    // Write something distinctive so we can prove the post-remove DB is empty.
    await first.graphDb.upsertFile(
      { relPath: "marker.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [] },
    );
    const beforeRows = await first.graphDb.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files");
    expect(beforeRows.map((r) => r.rel_path)).toContain("marker.ts");

    await pool.removeCollection("alpha");

    const second = await pool.acquire("alpha");
    expect(second.graphDb).not.toBe(first.graphDb);
    // Fresh DB — the prior marker row must NOT survive removeCollection.
    const afterRows = await second.graphDb.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files");
    expect(afterRows.map((r) => r.rel_path)).not.toContain("marker.ts");

    await pool.closeAll();
  });
});
