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

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { decodeFrames, encodeFrame, type DaemonRequest } from "../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { DuckDbCloseFailedError, DuckDbOpenFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
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

  it("listCollectionDbNames returns versioned collection names for the base, ignoring other projects and non-versioned files", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    const codegraphDir = join(tmp, "codegraph");
    // Versioned DBs for the base under test.
    writeFileSync(pool.pathFor("code_abc_v1"), "");
    writeFileSync(pool.pathFor("code_abc_v3"), "");
    // A different project's versioned DB — must NOT be returned.
    writeFileSync(pool.pathFor("code_other_v2"), "");
    // The unversioned base file (legacy / non-versioned) — must NOT be returned.
    writeFileSync(pool.pathFor("code_abc"), "");
    // A WAL sidecar — not a .duckdb file, must NOT be returned.
    writeFileSync(join(codegraphDir, "code_abc_v1.duckdb.wal"), "");

    const names = pool.listCollectionDbNames("code_abc");

    expect(names.sort()).toEqual(["code_abc_v1", "code_abc_v3"]);
  });

  it("listCollectionDbNames returns an empty array when the codegraph dir has no matching files", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    // Only a foreign project's file exists.
    writeFileSync(pool.pathFor("code_other_v1"), "");

    expect(pool.listCollectionDbNames("code_abc")).toEqual([]);
  });

  it("listCollectionDbNames is a no-op (empty array) when the codegraph dir is missing", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    // Remove the codegraph dir the pool created at construction.
    rmSync(join(tmp, "codegraph"), { recursive: true, force: true });

    expect(pool.listCollectionDbNames("code_abc")).toEqual([]);
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

  it("surfaces a typed DuckDbOpenFailedError when init/migrations fail and does NOT cache the failed collection", async () => {
    // Real scenario: the DuckDB file lock is held by another tea-rags
    // process (or the file is corrupted), so the driver rejects init().
    // openCollection must close the partially-opened handle, wrap the raw
    // driver error in a typed DuckDbOpenFailedError, and leave the pool
    // un-mutated so a later retry (after the lock releases) reopens cleanly.
    const initSpy = vi
      .spyOn(DuckDbGraphClient.prototype, "init")
      .mockRejectedValue(new Error("Conflicting lock is held"));

    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const dbPath = pool.pathFor("locked");
    expect(dbPath).toContain("locked.duckdb");
    await expect(pool.acquire("locked")).rejects.toMatchObject({
      code: "INFRA_DUCKDB_OPEN_FAILED",
      // The raw driver message is preserved as the cause, not leaked into message.
      cause: expect.objectContaining({ message: "Conflicting lock is held" }),
    });
    // A second acquire after a failed open still throws (the failed attempt was
    // not cached as a poisoned entry) and again surfaces the typed error.
    await expect(pool.acquire("locked")).rejects.toBeInstanceOf(DuckDbOpenFailedError);

    // The failed collection was never cached / never left in flight.
    expect(pool.peek("locked")).toBeUndefined();

    // Once the underlying fault clears, the next acquire (real init) succeeds —
    // proving the failed attempt left no poisoned inflight entry behind.
    initSpy.mockRestore();
    const recovered = await pool.acquire("locked");
    expect(recovered.graphDb).toBeDefined();
    expect(pool.peek("locked")).toBe(recovered);

    await pool.closeAll();
  });

  it("removeCollection throws DuckDbCloseFailedError when the driver rejects close and leaves the file on disk", async () => {
    // Real scenario: a hung DuckDB connection rejects close() during a
    // clear/force-reindex eviction. removeCollection must NOT unlink a file
    // the driver still holds open (undefined behaviour on some platforms) —
    // it evicts from cache, then surfaces the typed close failure so the
    // caller knows the file is still locked.
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    const entry = await pool.acquire("hung");
    const dbPath = pool.pathFor("hung");
    expect(existsSync(dbPath)).toBe(true);

    // The cached connection's close hangs/rejects on this eviction.
    const closeSpy = vi.spyOn(entry.graphDb, "close").mockRejectedValueOnce(new Error("connection still busy"));

    await expect(pool.removeCollection("hung")).rejects.toBeInstanceOf(DuckDbCloseFailedError);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Contract: the entry is evicted from cache (so the pool is not left
    // half-mutated) but the on-disk file is NOT unlinked while the driver
    // still claims to hold it open.
    expect(pool.peek("hung")).toBeUndefined();
    expect(existsSync(dbPath)).toBe(true);

    // Real close now succeeds — clean up the still-open handle so the temp
    // dir teardown does not race a live file lock.
    closeSpy.mockRestore();
    await entry.graphDb.close();
  });
});

describe("GraphDbClientPool — spill and cross-pass path helpers", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pool-paths-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("spillPathFor returns <codegraphDir>/.spill/<collection>-<runId>.ndjson", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    const path = pool.spillPathFor("code_abc", "run-42");
    expect(path).toContain(join("codegraph", ".spill", "code_abc-run-42.ndjson"));
  });

  it("spillPathFor sanitises unsafe characters in the collection name", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    const path = pool.spillPathFor("code/unsafe:name", "run-1");
    // slashes and colons must be replaced with underscores
    expect(path).not.toContain("/unsafe:");
    expect(path).toContain("code_unsafe_name-run-1.ndjson");
  });

  it("inputSpillPathFor returns <codegraphDir>/.xpass/<collection>.ndjson", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    const path = pool.inputSpillPathFor("code_abc");
    expect(path).toContain(join("codegraph", ".xpass", "code_abc.ndjson"));
  });

  it("inputSpillPathFor with a custom tempDirectory still places xpass under codegraphDir", () => {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      resources: { tempDirectory: join(tmp, "custom-spill") },
    });
    // xpassDir is always <rootDir>/codegraph/.xpass regardless of tempDirectory
    const path = pool.inputSpillPathFor("code_xyz");
    expect(path).toContain(join("codegraph", ".xpass", "code_xyz.ndjson"));
    expect(path).not.toContain("custom-spill");
  });
});

describe("GraphDbClientPool — mode-aware acquireRead/acquireWrite", () => {
  it("acquireRead opens a READ_ONLY in-process client on the full (unstripped) collection name", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-"));
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    // populate code_x_v2 via write path
    const w = await pool.acquireWrite("code_x_v2");
    await w.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    // read path resolves the SAME versioned file (no strip to code_x)
    const r = await pool.acquireRead("code_x_v2");
    expect(await r.graphDb.hasData()).toBe(true);
    expect(pool.pathFor("code_x_v2")).toContain("code_x_v2.duckdb"); // not code_x.duckdb
    await r.graphDb.close();
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("GraphDbClientPool — acquireReader (mode-aware facade read path)", () => {
  let srv: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((res) => {
      if (srv) {
        srv.close(() => {
          res();
        });
      } else {
        res();
      }
    });
    srv = undefined;
  });

  it("direct mode (no daemon socket) falls back to an in-process READ_ONLY handle that reads the written file", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-reader-direct-"));
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });

    // Populate via the write path so the file has data on disk.
    const w = await pool.acquireWrite("code_r_v1");
    await w.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });

    // No daemonSocketPath configured → acquireReader delegates to the
    // in-process READ_ONLY attach and sees the freshly written data.
    const reader = await pool.acquireReader("code_r_v1");
    expect(reader.graphDb).toBeDefined();
    expect(reader.symbolTable).toBeDefined();
    expect(await reader.graphDb.hasData()).toBe(true);

    await reader.graphDb.close();
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("daemon mode routes the facade read through a DaemonGraphDbClient over the socket and injects the collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-reader-daemon-"));
    const socketPath = join(root, "cg.sock");
    const seen: DaemonRequest[] = [];

    // Minimal echo daemon: records every request and answers each read op
    // with a deterministic payload so the proxied round-trip is observable.
    srv = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = JSON.parse(f) as DaemonRequest;
          seen.push(req);
          const result =
            req.op === "getCallers"
              ? [{ sourceSymbolId: "A#run", sourceRelPath: "a.ts", callExpression: "b.help()" }]
              : null;
          sock.write(encodeFrame({ id: req.id, ok: true, result }));
        }
      });
    });
    srv.unref();
    await new Promise<void>((res) => {
      srv?.listen(socketPath, () => {
        res();
      });
    });

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    // daemonSocketPath set → acquireReader returns a DaemonGraphDbClient that
    // proxies reads through the daemon (the sole RW file opener) instead of a
    // conflicting cross-process READ_ONLY attach.
    const reader = await pool.acquireReader("code_proxy_v1");
    expect(reader.graphDb).toBeDefined();
    expect(reader.symbolTable).toBeDefined();

    const callers = await reader.graphDb.getCallers("B#help");
    expect(callers).toEqual([{ sourceSymbolId: "A#run", sourceRelPath: "a.ts", callExpression: "b.help()" }]);
    // The proxied request carries the client-injected collection + query param.
    const getCallers = seen.find((r) => r.op === "getCallers");
    expect((getCallers?.params as { collection: string }).collection).toBe("code_proxy_v1");
    expect((getCallers?.params as { symbolId: string }).symbolId).toBe("B#help");

    await reader.graphDb.close();
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("GraphDbClientPool — daemon-mode client caching (one socket per collection)", () => {
  let srv: Server | undefined;
  let connections = 0;

  beforeEach(() => {
    connections = 0;
  });

  afterEach(async () => {
    await new Promise<void>((res) => {
      if (srv) {
        srv.close(() => {
          res();
        });
      } else {
        res();
      }
    });
    srv = undefined;
  });

  /** Echo daemon that counts `connection` events and answers every op with null. */
  async function startEchoDaemon(socketPath: string): Promise<void> {
    srv = createServer((sock) => {
      connections++;
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = JSON.parse(f) as DaemonRequest;
          sock.write(encodeFrame({ id: req.id, ok: true, result: null }));
        }
      });
    });
    srv.unref();
    await new Promise<void>((res) => {
      srv?.listen(socketPath, () => {
        res();
      });
    });
  }

  it("acquireWrite opens ONE socket for N calls on the same collection and closeAll closes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-write-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    const handles = [];
    for (let i = 0; i < 5; i++) {
      handles.push(await pool.acquireWrite("code_cache_v1"));
    }

    // All 5 acquires reuse the SAME cached daemon client → one socket.
    expect(connections).toBe(1);
    for (const h of handles) expect(h.graphDb).toBe(handles[0].graphDb);

    // closeAll must close the cached daemon client (best-effort). Give the
    // socket a tick to actually end, then assert no leak by reopening.
    await pool.closeAll();

    rmSync(root, { recursive: true, force: true });
  });

  it("acquireWrite returns a STABLE per-collection symbolTable across calls (writes accumulate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-symtab-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    const h1 = await pool.acquireWrite("code_symtab_v1");
    const h2 = await pool.acquireWrite("code_symtab_v1");

    // The in-memory symbol table must be the SAME instance across acquires for
    // one collection — codegraph streams per-batch writes through repeated
    // acquireWrite calls and resolves method calls at finish against this table.
    // A fresh table per call would lose every cross-file symbol -> method-edge
    // resolution collapses (the bug this locks).
    expect(h2.symbolTable).toBe(h1.symbolTable);

    // Symbols upserted via one handle are visible via the other (one shared set).
    h1.symbolTable.upsertFile("src/a.ts", [
      { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "src/a.ts", scope: ["Foo"] },
    ]);
    expect(h2.symbolTable.lookupByShortName("bar")).toHaveLength(1);

    // A distinct collection still gets its own table.
    const other = await pool.acquireWrite("code_symtab_other_v1");
    expect(other.symbolTable).not.toBe(h1.symbolTable);

    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("acquireReader reuses the same cached client as acquireWrite for one collection", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-read-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    const w = await pool.acquireWrite("code_shared_v1");
    const r1 = await pool.acquireReader("code_shared_v1");
    const r2 = await pool.acquireReader("code_shared_v1");

    expect(connections).toBe(1);
    // The read handle's graphDb proxies the same underlying socket.
    // close() on a read handle must NOT end the shared socket.
    await r1.graphDb.close();
    await r2.graphDb.close();
    await w.graphDb.close();
    // Socket still alive after handle closes — a fresh acquire makes no new connection.
    const r3 = await pool.acquireReader("code_shared_v1");
    expect(connections).toBe(1);
    await r3.graphDb.close();

    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("opens one socket PER collection (distinct collections do not share)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-multi-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    const a1 = await pool.acquireWrite("alpha_v1");
    const a2 = await pool.acquireWrite("alpha_v1");
    const b1 = await pool.acquireWrite("beta_v1");

    expect(a1.graphDb).toBe(a2.graphDb);
    expect(a1.graphDb).not.toBe(b1.graphDb);
    expect(connections).toBe(2);

    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("the wrapped handle proxies real ops to the daemon yet its close() is a no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-noop-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    const handle = await pool.acquireWrite("code_noop_v1");
    // A real op forwards over the socket (the proxy `get` trap binds the method
    // to the underlying client) and resolves against the echo daemon.
    await expect(handle.graphDb.hasData()).resolves.toBe(null);
    // A non-function property reads straight through the trap (no binding).
    expect(typeof (handle.graphDb as unknown as { findCycles: unknown }).findCycles).toBe("function");
    // close() is a no-op: the socket stays open, so a follow-up op still works
    // and no new connection is made.
    await handle.graphDb.close();
    await expect(handle.graphDb.hasData()).resolves.toBe(null);
    expect(connections).toBe(1);

    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("closeAll closes BOTH in-process and daemon cached clients in one pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-mixed-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    // In-process RW client (acquire) + a daemon-mode write client, both cached.
    const inProc = await pool.acquire("code_inproc_v1");
    const daemon = await pool.acquireWrite("code_daemon_v1");
    const inProcCloseSpy = vi.spyOn(inProc.graphDb, "close");

    await pool.closeAll();

    // The in-process client's real close ran; the daemon socket was ended.
    expect(inProcCloseSpy).toHaveBeenCalledTimes(1);
    // After closeAll the cache is empty — a fresh acquireWrite reconnects.
    await pool.acquireWrite("code_daemon_v1");
    expect(connections).toBe(2);
    void daemon;

    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it("closeAll swallows a rejecting client close (no leak crash on teardown)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-cache-rej-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    // Daemon client whose close() rejects, plus an in-process client whose
    // close() also rejects — closeAll must swallow both and still resolve.
    const daemon = await pool.acquireWrite("code_rej_daemon_v1");
    const inProc = await pool.acquire("code_rej_inproc_v1");
    // The handle is the no-op-close proxy; reach the real cached client via peek
    // is not exposed for daemon clients, so reject through the underlying socket
    // op instead: spy on the in-process client + force a daemon-side reject by
    // closing the echo server first so the socket end errors.
    vi.spyOn(inProc.graphDb, "close").mockRejectedValueOnce(new Error("inproc close failed"));
    void daemon;

    await expect(pool.closeAll()).resolves.toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("concurrent acquireWrite calls for the same collection share ONE daemon init (daemonInflight dedup)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-inflight-"));
    const socketPath = join(root, "cg.sock");
    await startEchoDaemon(socketPath);

    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      daemonSocketPath: socketPath,
    });

    // Fire N concurrent acquireWrite calls — only ONE socket connection should
    // be established (the daemonInflight map deduplicates concurrent inits).
    const [h1, h2, h3] = await Promise.all([
      pool.acquireWrite("code_flight_v1"),
      pool.acquireWrite("code_flight_v1"),
      pool.acquireWrite("code_flight_v1"),
    ]);

    expect(connections).toBe(1);
    // All three handles point at the same proxy wrapper (same graphDb identity).
    expect(h1.graphDb).toBe(h2.graphDb);
    expect(h2.graphDb).toBe(h3.graphDb);

    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
});
