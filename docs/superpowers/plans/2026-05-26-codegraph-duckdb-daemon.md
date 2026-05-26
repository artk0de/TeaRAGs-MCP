# Codegraph DuckDB Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate cross-process DuckDB single-writer lock contention in the codegraph layer by routing all writes + heavy graph analysis through one per-machine daemon, while reads stay in-process via read-only attach.

**Architecture:** A `CodegraphDaemon` (one per machine) owns the read-write DuckDB connections (an internal `GraphDbClientPool`) and runs the heavy `collectAdjacency→tarjanScc→pageRank` analysis. MCP server processes talk to it as IPC clients over a unix socket (newline-delimited JSON), using a `DaemonGraphDbClient` that implements the write subset of `GraphDbClient`. Reads (`getCallers`/`getCallees`/`findCycles`) bypass the daemon and open the live-version DuckDB file with `access_mode=READ_ONLY`. The seam is `GraphDbClientPool`, which becomes version-aware (full Qdrant collection name; `stripVersionSuffix` removed) and mode-aware (RW→daemon, RO→in-process).

**Tech Stack:** TypeScript (NodeNext ESM), `@duckdb/node-api`, `node:net` (unix socket), `node:child_process` (spawn), vitest. Lifecycle helpers adapted from `src/core/adapters/qdrant/embedded/daemon.ts` + `daemon-lock.ts`; socket transport modeled on the ONNX daemon (`onnx.sock`).

**Spec:** `docs/superpowers/specs/2026-05-26-codegraph-duckdb-daemon-design.md`

**Out of scope (follow-up epic):** eliminating the ~30 GB analysis allocation (measure heap → streaming Tarjan / DuckDB recursive CTE / edge cap). The daemon only *confines* it to one process and isolates it in one method.

**Deep-silo note:** every commit touching `src/core/adapters/duckdb/*` and `src/core/adapters/qdrant/embedded/*` MUST carry a `Why:` line per `.claude/rules/silo-pairing.md`. Each commit step below includes one.

---

## File Structure

| Path | Created/Modified | Responsibility |
| --- | --- | --- |
| `src/core/adapters/duckdb/client.ts` | Modify | add `accessMode` option → `READ_ONLY` open |
| `src/core/adapters/codegraph-daemon/protocol.ts` | Create | wire message types + `encodeFrame`/`decodeFrames` (newline JSON) |
| `src/core/adapters/codegraph-daemon/server.ts` | Create | `CodegraphDaemonServer` — owns internal pool, handles requests, runs analysis |
| `src/core/adapters/codegraph-daemon/lifecycle.ts` | Create | spawn-on-demand, file refcount, idle-shutdown, single-spawn lock |
| `src/core/adapters/codegraph-daemon/client.ts` | Create | `DaemonGraphDbClient` — write subset of `GraphDbClient` over the socket |
| `src/core/adapters/codegraph-daemon/entry.ts` | Create | daemon process entrypoint (CLI-spawned) |
| `src/core/adapters/codegraph-daemon/index.ts` | Create | barrel |
| `src/core/adapters/duckdb/pool.ts` | Modify | version-aware + mode-aware (`acquireRead`/`acquireWrite`) |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts` | Modify | `getStore` routing + `recomputeGraphMetricsStreaming`→RPC; remove `stripVersionSuffix` use |
| `src/bootstrap/factory.ts` | Modify | wire daemon manager into pool/GraphFacade/provider |

---

## Task 1: `accessMode` read-only option on `DuckDbGraphClient`

**Files:**
- Modify: `src/core/adapters/duckdb/client.ts:42-70` (options), `:90-93` (init)
- Test: `tests/core/adapters/duckdb/client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/core/adapters/duckdb/client.test.ts` (reuse its existing temp-dir + `runMigrations` setup):

```ts
it("READ_ONLY client rejects writes but reads a pre-populated DB", async () => {
  // Arrange: build a populated DB with a normal RW client.
  const rw = new DuckDbGraphClient({ path: dbPath });
  await rw.init();
  await runMigrations(rw, DATABASE_MIGRATIONS);
  await rw.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
  await rw.close();

  // Act: open the same file read-only.
  const ro = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
  await ro.init();

  // Assert: reads work, writes throw.
  expect(await ro.hasData()).toBe(true);
  await expect(
    ro.upsertFile({ relPath: "b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] }),
  ).rejects.toThrow();
  await ro.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/client.test.ts -t "READ_ONLY"`
Expected: FAIL — `accessMode` not accepted / write does not throw (DB opened RW).

- [ ] **Step 3: Implement the option**

In `DuckDbGraphClientOptions` (client.ts:42) add:

```ts
export interface DuckDbGraphClientOptions {
  path: string;
  /** Open mode. Default READ_WRITE. READ_ONLY allows concurrent cross-process readers. */
  accessMode?: "READ_WRITE" | "READ_ONLY";
  resources?: {
    memoryLimit?: string;
    threads?: number;
    tempDirectory?: string;
    preserveInsertionOrder?: boolean;
  };
}
```

In `init()` (client.ts:90-93) pass the access mode through the DuckDB config. `@duckdb/node-api` `DuckDBInstance.create` accepts a config object as the 2nd arg:

```ts
async init(): Promise<void> {
  mkdirSync(dirname(this.options.path), { recursive: true });
  const config: Record<string, string> = {};
  if (this.options.accessMode) config.access_mode = this.options.accessMode;
  this.instance = await DuckDBInstance.create(this.options.path, config);
  this.conn = await this.instance.connect();
  // ... existing resource SET statements unchanged ...
}
```

Guard the resource `SET` block so a READ_ONLY connection does not attempt `SET memory_limit` writes that DuckDB rejects on a read-only DB (wrap existing `SET` calls in `if (this.options.accessMode !== "READ_ONLY")`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/client.test.ts`
Expected: PASS (new test + all existing client tests green).

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/client.ts tests/core/adapters/duckdb/client.test.ts
git commit -m "feat(adapters): add READ_ONLY access mode to DuckDbGraphClient

Why: codegraph read path will open the live-version DuckDB read-only so
multiple MCP processes can query concurrently while one daemon holds RW.
Trade-off: RO connection skips resource SET statements (rejected on RO DB)."
```

---

## Task 2: Daemon wire protocol + framing codec

**Files:**
- Create: `src/core/adapters/codegraph-daemon/protocol.ts`
- Test: `tests/core/adapters/codegraph-daemon/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrames, type DaemonRequest, type DaemonResponse } from
  "../../../../src/core/adapters/codegraph-daemon/protocol.js";

describe("daemon protocol framing", () => {
  it("round-trips a request through encode → decode", () => {
    const req: DaemonRequest = { id: 7, op: "upsertFile",
      params: { collection: "code_x_v1", node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] } } };
    const { frames, rest } = decodeFrames(encodeFrame(req));
    expect(rest).toBe("");
    expect(JSON.parse(frames[0])).toEqual(req);
  });

  it("decodes multiple frames and leaves a partial tail in rest", () => {
    const a = encodeFrame({ id: 1, op: "checkpoint", params: { collection: "c" } } as DaemonRequest);
    const b = encodeFrame({ id: 2, op: "checkpoint", params: { collection: "c" } } as DaemonRequest);
    const buf = a + b.slice(0, b.length - 3); // truncate second frame
    const { frames, rest } = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(rest).toBe(b.slice(0, b.length - 3));
  });

  it("response carries ok | error discriminant", () => {
    const ok: DaemonResponse = { id: 1, ok: true, result: null };
    const err: DaemonResponse = { id: 2, ok: false, error: { name: "CodegraphResolveError", message: "boom" } };
    expect(JSON.parse(decodeFrames(encodeFrame(ok)).frames[0]).ok).toBe(true);
    expect(JSON.parse(decodeFrames(encodeFrame(err)).frames[0]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/protocol.test.ts`
Expected: FAIL — module `protocol.js` not found.

- [ ] **Step 3: Implement protocol.ts**

```ts
import type { GraphEdges, GraphFileNode, RelPath } from "../../contracts/types/codegraph.js";

export type DaemonOp =
  | "handshake"
  | "upsertFile"
  | "removeSymbolsForFile"
  | "computeAndPersistCyclesAndSignals"
  | "checkpoint"
  | "finalizeReindex";

export interface DaemonRequest {
  id: number;
  op: DaemonOp;
  params:
    | { collection: string } // handshake | checkpoint | computeAndPersistCyclesAndSignals
    | { collection: string; node: GraphFileNode; edges: GraphEdges } // upsertFile
    | { collection: string; relPath: RelPath } // removeSymbolsForFile
    | { collection: string; oldVersion: string; newVersion: string }; // finalizeReindex
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

/** One JSON object per line. `\n` is the frame delimiter (JSON.stringify never emits a raw newline). */
export function encodeFrame(msg: DaemonRequest | DaemonResponse): string {
  return JSON.stringify(msg) + "\n";
}

/** Split a buffer on newlines; return complete frames and the partial trailing `rest`. */
export function decodeFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.length > 0), rest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/codegraph-daemon/protocol.ts tests/core/adapters/codegraph-daemon/protocol.test.ts
git commit -m "feat(adapters): codegraph daemon wire protocol + newline-JSON framing"
```

---

## Task 3: `CodegraphDaemonServer` — request handling + analysis

**Files:**
- Create: `src/core/adapters/codegraph-daemon/server.ts`
- Test: `tests/core/adapters/codegraph-daemon/server.test.ts`

The server owns an internal `GraphDbClientPool` (RW). It dispatches each `DaemonRequest` to the pooled `graphDb`. `computeAndPersistCyclesAndSignals` runs the analysis locally (moved from `provider.ts`'s `recomputeGraphMetricsStreaming`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodegraphDaemonServer } from "../../../../src/core/adapters/codegraph-daemon/server.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function makeServer() {
  root = mkdtempSync(join(tmpdir(), "cg-daemon-"));
  const pool = new GraphDbClientPool({ rootDir: root, symbolTableFactory: () => new InMemoryGlobalSymbolTable() });
  return { server: new CodegraphDaemonServer(pool), pool };
}

describe("CodegraphDaemonServer.handle", () => {
  it("upsertFile then computeAndPersistCyclesAndSignals persists with no throw", async () => {
    const { server, pool } = makeServer();
    const c = "code_test_v1";
    expect((await server.handle({ id: 1, op: "handshake", params: { collection: c } })).ok).toBe(true);
    const up = await server.handle({ id: 2, op: "upsertFile",
      params: { collection: c, node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] } } });
    expect(up.ok).toBe(true);
    const an = await server.handle({ id: 3, op: "computeAndPersistCyclesAndSignals", params: { collection: c } });
    expect(an.ok).toBe(true);
    const { graphDb } = await pool.acquire(c);
    expect(await graphDb.hasData()).toBe(true);
    await pool.closeAll();
  });

  it("returns ok:false with typed error name on a failing op", async () => {
    const { server, pool } = makeServer();
    // unknown op → error response, not a throw
    const res = await server.handle({ id: 9, op: "bogus" as never, params: { collection: "c" } });
    expect(res.ok).toBe(false);
    await pool.closeAll();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/server.test.ts`
Expected: FAIL — `server.js` not found.

- [ ] **Step 3: Implement server.ts**

```ts
import type { GraphDbClientPool } from "../duckdb/pool.js";
import type { DaemonRequest, DaemonResponse } from "./protocol.js";
import { tarjanScc } from "../../domains/trajectory/codegraph/infra/tarjan-scc.js";
import { pageRank } from "../../domains/trajectory/codegraph/infra/page-rank.js";
import type { GraphDbClient, CycleScope } from "../../contracts/types/codegraph.js";

export class CodegraphDaemonServer {
  constructor(private readonly pool: GraphDbClientPool) {}

  async handle(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const result = await this.dispatch(req);
      return { id: req.id, ok: true, result };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { id: req.id, ok: false, error: { name: e.name, message: e.message } };
    }
  }

  private async dispatch(req: DaemonRequest): Promise<unknown> {
    const p = req.params as Record<string, unknown>;
    const collection = p.collection as string;
    switch (req.op) {
      case "handshake":
        await this.pool.acquire(collection); // opens + migrates + hydrates
        return null;
      case "upsertFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.upsertFile(p.node as never, p.edges as never);
        return null;
      }
      case "removeSymbolsForFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.removeSymbolsForFile(p.relPath as string);
        return null;
      }
      case "checkpoint": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.checkpoint();
        return null;
      }
      case "computeAndPersistCyclesAndSignals": {
        const { graphDb } = await this.pool.acquire(collection);
        await computeAndPersistCyclesAndSignals(graphDb);
        return null;
      }
      case "finalizeReindex":
        // implemented in Task 8
        await this.pool.removeCollection(p.oldVersion as string);
        return null;
      default:
        throw new Error(`unknown daemon op: ${String(req.op)}`);
    }
  }
}

/** Moved verbatim from provider.ts recomputeGraphMetricsStreaming body. Runs daemon-side. */
export async function computeAndPersistCyclesAndSignals(graphDb: GraphDbClient): Promise<void> {
  const fileAdj = await collectAdjacency(graphDb, "file");
  await graphDb.replaceCycles("file", tarjanScc(fileAdj));
  const methodAdj = await collectAdjacency(graphDb, "method");
  await graphDb.replaceCycles("method", tarjanScc(methodAdj));
  await graphDb.replacePageRanks(pageRank(methodAdj).ranks);
}

async function collectAdjacency(graphDb: GraphDbClient, scope: CycleScope): Promise<Map<string, string[]>> {
  const adj = new Map<string, string[]>();
  for await (const [source, target] of graphDb.streamAdjacency(scope)) {
    const list = adj.get(source);
    if (list) list.push(target);
    else adj.set(source, [target]);
  }
  return adj;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/codegraph-daemon/server.ts tests/core/adapters/codegraph-daemon/server.test.ts
git commit -m "feat(adapters): CodegraphDaemonServer request dispatch + daemon-side graph analysis

Why: the 30GB collectAdjacency/tarjan/pageRank analysis must run in the single
daemon process (not N client processes); server owns the RW pool so cross-process
lock contention is eliminated at the source."
```

---

## Task 4: Daemon lifecycle — spawn / refcount / idle-shutdown / single-spawn lock

**Files:**
- Create: `src/core/adapters/codegraph-daemon/lifecycle.ts`
- Test: `tests/core/adapters/codegraph-daemon/lifecycle.test.ts`

Adapt the file-based helpers from `adapters/qdrant/embedded/daemon.ts` (`getDaemonPaths`, `readRefs`/`incrementRefs`/`decrementRefs`, `scheduleIdleWatcher`) and the `DaemonLock` from `daemon-lock.ts`. Socket path is `<storage>/codegraph-daemon.sock`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDaemonPaths, incrementRefs, decrementRefs, readRefs } from
  "../../../../src/core/adapters/codegraph-daemon/lifecycle.js";

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("codegraph daemon lifecycle refcount", () => {
  it("paths include socket + pid + refs + lock under the storage dir", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    expect(p.socketPath.endsWith("codegraph-daemon.sock")).toBe(true);
    expect(p.refsFile.endsWith("codegraph-daemon.refs")).toBe(true);
    expect(p.lockFile.endsWith("codegraph-daemon.lock")).toBe(true);
  });

  it("increment/decrement refs are symmetric and floored at 0", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    expect(incrementRefs(p)).toBe(1);
    expect(incrementRefs(p)).toBe(2);
    expect(decrementRefs(p)).toBe(1);
    expect(decrementRefs(p)).toBe(0);
    expect(decrementRefs(p)).toBe(0); // floored
    expect(readRefs(p)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/lifecycle.test.ts`
Expected: FAIL — `lifecycle.js` not found.

- [ ] **Step 3: Implement lifecycle.ts**

Mirror the Qdrant helpers (read `adapters/qdrant/embedded/daemon.ts:98-200` for the exact bodies). Minimal shape:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DaemonLock } from "../qdrant/embedded/daemon-lock.js";

export interface CodegraphDaemonPaths {
  socketPath: string; pidFile: string; portFile: string;
  refsFile: string; lockFile: string; storageDir: string;
}

export function getStorageDir(appDataPath?: string): string {
  return process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR
    ?? join(appDataPath ?? join(process.env.HOME ?? ".", ".tea-rags"), "codegraph");
}

export function getDaemonPaths(storageDir: string): CodegraphDaemonPaths {
  return {
    storageDir,
    socketPath: join(storageDir, "codegraph-daemon.sock"),
    pidFile: join(storageDir, "codegraph-daemon.pid"),
    portFile: join(storageDir, "codegraph-daemon.port"),
    refsFile: join(storageDir, "codegraph-daemon.refs"),
    lockFile: join(storageDir, "codegraph-daemon.lock"),
  };
}

export function readRefs(p: CodegraphDaemonPaths): number {
  try { return parseInt(readFileSync(p.refsFile, "utf8"), 10) || 0; } catch { return 0; }
}
const lock = new DaemonLock();
function withRefsLock<T>(p: CodegraphDaemonPaths, fn: () => T): T {
  mkdirSync(dirname(p.refsFile), { recursive: true });
  // simplest correct form: reuse readRefs/write under DaemonLock-guarded section
  return fn();
}
export function incrementRefs(p: CodegraphDaemonPaths): number {
  return withRefsLock(p, () => { const n = readRefs(p) + 1; writeFileSync(p.refsFile, String(n)); return n; });
}
export function decrementRefs(p: CodegraphDaemonPaths): number {
  return withRefsLock(p, () => { const n = Math.max(0, readRefs(p) - 1); writeFileSync(p.refsFile, String(n)); return n; });
}

export const IDLE_SHUTDOWN_MS = 30_000;
export function scheduleIdleWatcher(p: CodegraphDaemonPaths, onShutdown: () => void): NodeJS.Timeout {
  let idleSince: number | null = null;
  const t = setInterval(() => {
    if (readRefs(p) <= 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) { clearInterval(t); onShutdown(); }
    } else { idleSince = null; }
  }, 5_000);
  t.unref();
  return t;
}
```

> NOTE for implementer: copy the real `withRefsLock` body from the Qdrant
> `incrementRefs`/`decrementRefs` (daemon.ts:168-187), which acquire/release the
> `DaemonLock` around the read-modify-write. The skeleton above shows the
> contract; match the Qdrant locking exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/codegraph-daemon/lifecycle.ts tests/core/adapters/codegraph-daemon/lifecycle.test.ts
git commit -m "feat(adapters): codegraph daemon lifecycle (paths, file refcount, idle watcher)

Why: refcount + idle-shutdown reuse the proven Qdrant embedded-daemon pattern so
the codegraph daemon shuts down when the last MCP client disconnects, freeing the
RW DuckDB lock for the next cold spawn."
```

---

## Task 5: `DaemonGraphDbClient` — socket client (write subset)

**Files:**
- Create: `src/core/adapters/codegraph-daemon/client.ts`
- Test: `tests/core/adapters/codegraph-daemon/client.test.ts`

`DaemonGraphDbClient` connects to the unix socket, sends `DaemonRequest`s, awaits the matching `DaemonResponse` by `id`. Implements only the write subset; read methods throw `UnsupportedDaemonReadError` (reads use the in-process RO handle).

- [ ] **Step 1: Write the failing test**

Run a real in-process server over a temp unix socket and drive the client against it:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonGraphDbClient } from "../../../../src/core/adapters/codegraph-daemon/client.js";
import { encodeFrame, decodeFrames, type DaemonRequest } from
  "../../../../src/core/adapters/codegraph-daemon/protocol.js";

let dir: string; let srv: Server;
afterEach(async () => { srv?.close(); dir && rmSync(dir, { recursive: true, force: true }); });

function echoServer(socketPath: string, onReq: (r: DaemonRequest) => unknown): Promise<void> {
  srv = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const { frames, rest } = decodeFrames(buf); buf = rest;
      for (const f of frames) {
        const req = JSON.parse(f) as DaemonRequest;
        sock.write(encodeFrame({ id: req.id, ok: true, result: onReq(req) }));
      }
    });
  });
  return new Promise((res) => srv.listen(socketPath, () => res()));
}

describe("DaemonGraphDbClient", () => {
  it("upsertFile sends an upsertFile request and resolves on ok", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    const seen: DaemonRequest[] = [];
    await echoServer(socketPath, (r) => { seen.push(r); return null; });

    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    await client.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.close();

    expect(seen.map((r) => r.op)).toContain("upsertFile");
  });

  it("read methods throw (reads go through in-process RO handle)", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgc-"));
    const socketPath = join(dir, "d.sock");
    await echoServer(socketPath, () => null);
    const client = new DaemonGraphDbClient(socketPath, "code_x_v1");
    await client.init();
    await expect(client.getCallers("Foo#bar")).rejects.toThrow();
    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/client.test.ts`
Expected: FAIL — `client.js` not found.

- [ ] **Step 3: Implement client.ts**

```ts
import { connect, type Socket } from "node:net";
import type {
  GraphDbClient, GraphEdges, GraphFileNode, RelPath, SymbolId,
  CallerEdge, CalleeEdge, CycleEntry, CycleScope, SymbolDefinition,
} from "../../contracts/types/codegraph.js";
import { encodeFrame, decodeFrames, type DaemonOp, type DaemonResponse } from "./protocol.js";

class UnsupportedDaemonReadError extends Error {
  constructor(op: string) { super(`DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`); }
}

export class DaemonGraphDbClient implements GraphDbClient {
  private sock?: Socket;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly socketPath: string, private readonly collection: string) {}

  async init(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sock = connect(this.socketPath);
      this.sock.once("connect", resolve);
      this.sock.once("error", reject);
      this.sock.on("data", (d) => this.onData(d.toString("utf8")));
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const { frames, rest } = decodeFrames(this.buf); this.buf = rest;
    for (const f of frames) {
      const res = JSON.parse(f) as DaemonResponse;
      const p = this.pending.get(res.id); if (!p) continue;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(Object.assign(new Error(res.error.message), { name: res.error.name }));
    }
  }

  private call(op: DaemonOp, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock!.write(encodeFrame({ id, op, params: { collection: this.collection, ...params } } as never));
    });
  }

  async close(): Promise<void> { this.sock?.end(); this.sock = undefined; }

  // --- write subset (proxied) ---
  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> { await this.call("upsertFile", { node, edges }); }
  async removeSymbolsForFile(relPath: RelPath): Promise<void> { await this.call("removeSymbolsForFile", { relPath }); }
  async checkpoint(): Promise<void> { await this.call("checkpoint", {}); }
  async computeAndPersistCyclesAndSignals(): Promise<void> { await this.call("computeAndPersistCyclesAndSignals", {}); }

  // --- read subset (unsupported on the daemon client) ---
  getCallers(_: SymbolId): Promise<CallerEdge[]> { throw new UnsupportedDaemonReadError("getCallers"); }
  getCallees(_: SymbolId): Promise<CalleeEdge[]> { throw new UnsupportedDaemonReadError("getCallees"); }
  findCycles(_: CycleScope): Promise<CycleEntry[]> { throw new UnsupportedDaemonReadError("findCycles"); }
  // ...remaining GraphDbClient read methods throw UnsupportedDaemonReadError the same way...
  // (getFanIn, getFanOut, getCalledByCount, getCallSiteCount, getTransitiveImpact,
  //  getPageRank, listAdjacency, streamAdjacency, listAllSymbols, hasData, removeFile,
  //  upsertSymbols, replaceCycles, replacePageRanks)
}
```

> NOTE: `computeAndPersistCyclesAndSignals` is NOT on the current `GraphDbClient`
> interface — add it as an optional method on the interface in Task 7 (Step 3a),
> so both `DuckDbGraphClient` and `DaemonGraphDbClient` declare it. For now the
> client compiles because the method is concrete here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/codegraph-daemon/client.ts tests/core/adapters/codegraph-daemon/client.test.ts
git commit -m "feat(adapters): DaemonGraphDbClient socket proxy (write subset)"
```

---

## Task 6: `GraphDbClientPool` seam — version-aware + mode-aware

**Files:**
- Modify: `src/core/adapters/duckdb/pool.ts`
- Test: `tests/core/adapters/duckdb/pool.test.ts`

Add `acquireRead(collection)` (in-process RO `DuckDbGraphClient` on `pathFor(collection)` — NO version strip) and `acquireWrite(collection)` (returns a `DaemonGraphDbClient` when a daemon socket is configured, else the existing RW in-process handle for tests/direct mode). Keep `acquire()` as a deprecated alias of `acquireWrite()` so existing callers compile.

- [ ] **Step 1: Write the failing test**

```ts
it("acquireRead opens a READ_ONLY in-process client on the full (unstripped) collection name", async () => {
  const root = mkdtempSync(join(tmpdir(), "pool-"));
  const pool = new GraphDbClientPool({ rootDir: root, symbolTableFactory: () => new InMemoryGlobalSymbolTable() });
  // populate code_x_v2 via write path
  const w = await pool.acquireWrite("code_x_v2");
  await w.graphDb.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
  // read path resolves the SAME versioned file (no strip to code_x)
  const r = await pool.acquireRead("code_x_v2");
  expect(await r.graphDb.hasData()).toBe(true);
  expect(pool.pathFor("code_x_v2")).toContain("code_x_v2.duckdb"); // not code_x.duckdb
  await pool.closeAll();
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/pool.test.ts -t "acquireRead"`
Expected: FAIL — `acquireRead` not a function.

- [ ] **Step 3: Implement pool changes**

Add to `GraphDbClientPoolOptions`: `daemonSocketPath?: string`. Add methods:

```ts
async acquireWrite(collectionName: string): Promise<CollectionGraphHandle> {
  if (this.options.daemonSocketPath) {
    const { DaemonGraphDbClient } = await import("../codegraph-daemon/client.js");
    const graphDb = new DaemonGraphDbClient(this.options.daemonSocketPath, collectionName);
    await graphDb.init();
    return { graphDb, symbolTable: this.options.symbolTableFactory() };
  }
  return this.acquire(collectionName); // existing in-process RW path (direct/test mode)
}

async acquireRead(collectionName: string): Promise<CollectionGraphHandle> {
  const graphDb = new DuckDbGraphClient({ path: this.pathFor(collectionName), accessMode: "READ_ONLY" });
  await graphDb.init();
  return { graphDb, symbolTable: this.options.symbolTableFactory() };
}
```

(`pathFor` already uses the full name — the version strip lives only in `provider.ts`, removed in Task 7. No change needed in `pathFor`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/duckdb/pool.test.ts`
Expected: PASS (new + existing pool tests green).

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/duckdb/pool.ts tests/core/adapters/duckdb/pool.test.ts
git commit -m "feat(adapters): GraphDbClientPool mode-aware acquireRead/acquireWrite

Why: separates the read path (in-process RO attach, concurrent across processes)
from the write path (daemon socket when configured), the core of the lock fix.
acquireRead opens READ_ONLY on the full versioned filename."
```

---

## Task 7: `provider.ts` — route writes to daemon + remove version strip

**Files:**
- Modify: `src/core/contracts/types/codegraph.ts` (add optional `computeAndPersistCyclesAndSignals` to `GraphDbClient`)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts:141` (drop strip use), `:507-524` (getStore), `:871-883` (analysis → RPC)
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("recompute step delegates to graphDb.computeAndPersistCyclesAndSignals when present", async () => {
  const calls: string[] = [];
  const fakeGraphDb = {
    computeAndPersistCyclesAndSignals: async () => { calls.push("rpc"); },
    // minimal stubs for other methods touched in the pass...
  } as unknown as GraphDbClient;
  const provider = new CodegraphEnrichmentProvider({ graphDb: fakeGraphDb, symbolTable: new InMemoryGlobalSymbolTable(), resolvers: new Map() });
  await (provider as unknown as { recomputeGraphMetricsStreaming: (c?: string) => Promise<void> })
    .recomputeGraphMetricsStreaming("code_x_v1");
  expect(calls).toEqual(["rpc"]);
});

it("getStore acquires the FULL versioned collection name (no strip)", async () => {
  const acquired: string[] = [];
  const fakePool = { acquireWrite: async (c: string) => { acquired.push(c); return { graphDb: {} as GraphDbClient, symbolTable: new InMemoryGlobalSymbolTable() }; } };
  const provider = new CodegraphEnrichmentProvider({ pool: fakePool as never, resolvers: new Map() });
  await (provider as unknown as { getStore: (c?: string) => Promise<unknown> }).getStore("code_x_v6");
  expect(acquired).toEqual(["code_x_v6"]); // NOT "code_x"
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider.test.ts -t "computeAndPersist|FULL versioned"`
Expected: FAIL — strip still applied; analysis still inline.

- [ ] **Step 3a: Extend the interface**

In `contracts/types/codegraph.ts` `GraphDbClient` add (optional, so RO/in-process impls need not provide it):

```ts
/** Runs SCC + PageRank over the whole graph and persists results. Daemon-side. */
computeAndPersistCyclesAndSignals?: () => Promise<void>;
```

- [ ] **Step 3b: Update getStore (provider.ts:507-524)**

Replace `return this.deps.pool.acquire(stripVersionSuffix(collectionName));` with:

```ts
return this.deps.pool.acquireWrite(collectionName);
```

Leave `stripVersionSuffix` exported (other call sites/tests may reference it) but stop using it here. Also update `spillPathFor` call (~595) to use the full `collectionName`.

- [ ] **Step 3c: Update the analysis block (provider.ts:871-883)**

```ts
private async recomputeGraphMetricsStreaming(collectionName?: string): Promise<void> {
  const { graphDb } = await this.getStore(collectionName);
  if (graphDb.computeAndPersistCyclesAndSignals) {
    await graphDb.computeAndPersistCyclesAndSignals(); // daemon runs analysis; 30GB stays daemon-side
    return;
  }
  // Direct/in-process fallback (tests): run locally.
  const fileAdj = await collectAdjacency(graphDb, "file");
  await graphDb.replaceCycles("file", tarjanScc(fileAdj));
  const methodAdj = await collectAdjacency(graphDb, "method");
  await graphDb.replaceCycles("method", tarjanScc(methodAdj));
  await graphDb.replacePageRanks(pageRank(methodAdj).ranks);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider.test.ts`
Expected: PASS (new + existing provider tests green — business-logic tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/codegraph.ts src/core/domains/trajectory/codegraph/symbols/provider.ts tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
git commit -m "feat(codegraph): route writes through daemon + drop version-suffix strip

Why: getStore now acquires the full Qdrant collection name (versioned DuckDB
file) and writes via acquireWrite (daemon when configured); analysis delegates to
the daemon-side computeAndPersistCyclesAndSignals when available, keeping the
30GB graph build out of every MCP process. Direct mode keeps the inline path for
tests."
```

---

## Task 8: force_reindex versioned swap + `finalizeReindex`

**Files:**
- Modify: `src/core/adapters/codegraph-daemon/server.ts` (`finalizeReindex` deletes old version file via `pool.removeCollection`)
- Modify: `src/core/adapters/codegraph-daemon/client.ts` (add `finalizeReindex(oldVersion, newVersion)` write method)
- Test: `tests/core/adapters/codegraph-daemon/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("finalizeReindex deletes the old version DB file, new version readable", async () => {
  const { server, pool } = makeServer();
  await server.handle({ id: 1, op: "upsertFile",
    params: { collection: "code_x_v1", node: { relPath: "a.ts", language: "typescript" }, edges: { fileEdges: [], methodEdges: [] } } });
  await server.handle({ id: 2, op: "upsertFile",
    params: { collection: "code_x_v2", node: { relPath: "a.ts", language: "typescript" }, edges: { fileEdges: [], methodEdges: [] } } });
  const oldPath = pool.pathFor("code_x_v1");
  expect(existsSync(oldPath)).toBe(true);
  const res = await server.handle({ id: 3, op: "finalizeReindex", params: { collection: "code_x_v2", oldVersion: "code_x_v1", newVersion: "code_x_v2" } });
  expect(res.ok).toBe(true);
  expect(existsSync(oldPath)).toBe(false);            // old deleted
  expect(await (await pool.acquireRead("code_x_v2")).graphDb.hasData()).toBe(true); // new live
  await pool.closeAll();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/server.test.ts -t "finalizeReindex"`
Expected: FAIL — old file still present (`removeCollection` not deleting the `.duckdb`).

- [ ] **Step 3: Implement**

In `pool.ts` ensure `removeCollection(name)` closes the entry AND unlinks `pathFor(name)` + its `.wal` (extend if it currently only evicts the map entry). In `server.ts` `finalizeReindex` calls `await this.pool.removeCollection(p.oldVersion)`. In `client.ts` add:

```ts
async finalizeReindex(oldVersion: string, newVersion: string): Promise<void> {
  await this.call("finalizeReindex", { oldVersion, newVersion });
}
```

(The Qdrant alias swap that flips the live version is already performed by the existing force-reindex path in `adapters/qdrant/aliases.ts:switchAlias`; codegraph readers follow the alias on their next `acquireRead`. `finalizeReindex` only does the old-file cleanup.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/codegraph-daemon/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/codegraph-daemon/server.ts src/core/adapters/codegraph-daemon/client.ts src/core/adapters/duckdb/pool.ts tests/core/adapters/codegraph-daemon/server.test.ts
git commit -m "feat(codegraph): finalizeReindex deletes superseded version DB after alias swap

Why: force_reindex builds a new code_xxx_vN.duckdb while readers stay on the old
version; once Qdrant swaps the alias, the daemon deletes the old file. Zero read
downtime, crash-safe (old intact until swap)."
```

---

## Task 9: `factory.ts` wiring (highest blast radius — isolated, explicit tests)

**Files:**
- Create: `src/core/adapters/codegraph-daemon/entry.ts` (process entrypoint that runs the socket server)
- Modify: `src/bootstrap/factory.ts:220-254` (pool gets `daemonSocketPath`; spawn-on-demand)
- Create: `src/core/adapters/codegraph-daemon/index.ts` (barrel)
- Test: `tests/bootstrap/factory.test.ts` (or the nearest existing factory test)

- [ ] **Step 1: Write the failing test**

```ts
it("wireCodegraph passes a daemonSocketPath into the pool when daemon mode is enabled", () => {
  const ctx = wireCodegraph(configWithCodegraphEnabled, zodConfig);
  // pool constructed with daemonSocketPath derived from getDaemonPaths(storageDir)
  expect((ctx!.pool as unknown as { options: { daemonSocketPath?: string } }).options.daemonSocketPath)
    .toMatch(/codegraph-daemon\.sock$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bootstrap/factory.test.ts -t "daemonSocketPath"`
Expected: FAIL — pool built without `daemonSocketPath`.

- [ ] **Step 3: Implement**

`entry.ts`: construct an internal `GraphDbClientPool` (RW, real resources) + `CodegraphDaemonServer`, `createServer` on the unix socket, write pid/port, `incrementRefs` per connection / `decrementRefs` on disconnect, `scheduleIdleWatcher` → `server.close()` + `cleanup` + `process.exit(0)`.

`factory.ts wireCodegraph` (220-254): compute `const paths = getDaemonPaths(getStorageDir(rootDir));`, pass `daemonSocketPath: paths.socketPath` into the `new GraphDbClientPool({...})` options, and ensure the daemon is spawned on demand (lazy: first `acquireWrite` triggers a `ensureCodegraphDaemon(paths)` that does the lock-guarded `spawn(process.execPath, [entryJsPath], { detached, stdio: "ignore" })` + `incrementRefs`). `GraphFacade` continues to receive `{ pool }`; its read methods call `pool.acquireRead`.

- [ ] **Step 4: Run test to verify it passes + full suite**

Run: `npx vitest run` and `npm run build`
Expected: PASS across the suite; type-check clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/codegraph-daemon/entry.ts src/core/adapters/codegraph-daemon/index.ts src/bootstrap/factory.ts tests/bootstrap/factory.test.ts
git commit -m "feat(codegraph): wire codegraph daemon into bootstrap (pool socket + spawn-on-demand)

Why: factory is the DI hub (fanOut 17); wiring the daemon socket here is the last
step so every prior task is independently tested before the highest-blast-radius
change. GraphFacade reads via acquireRead, ingest writes via acquireWrite→daemon."
```

---

## Self-Review

- **Spec coverage:** daemon process (T3,T4,T9) · narrow protocol (T2) · DaemonGraphDbClient write subset (T5) · access_mode RO reads (T1) · pool seam version+mode aware (T6) · provider routing + un-strip (T7) · force_reindex swap + delete-old (T8) · factory wiring (T9). All spec sections covered.
- **Type consistency:** `computeAndPersistCyclesAndSignals` added to `GraphDbClient` in T7-3a; used in T3 (server), T5 (client), T7 (provider). `CollectionGraphHandle` = `{ graphDb, symbolTable }` used consistently. `acquireWrite`/`acquireRead` defined in T6, consumed in T7/T9.
- **Out-of-scope guard:** no task touches `tarjan-scc.ts`/`page-rank.ts` internals (memory follow-up epic owns those).
- **Deep-silo:** every commit touching `adapters/duckdb/*` carries a `Why:` line (T1, T6, T8). Daemon module is new (not yet silo).
