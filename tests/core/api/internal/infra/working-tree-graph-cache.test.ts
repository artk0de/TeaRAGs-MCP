/**
 * WorkingTreeGraphCache (bd tea-rags-mcp-xi2r9, WTO-7 T12): the tree graph's
 * build scheduling and on-disk lifecycle, against a fake builder and a fake
 * base pool in a temp appData. What is pinned: one build per key in-process,
 * the caller's wait budget, the failure backoff, publish-by-rename (no reader
 * ever sees a half-built key dir), the cross-process race, the snapshot's
 * per-base-version reuse, and the sweep's retention matrix. Live-found
 * defects pinned after it: the content-based key (D7), retention after every
 * publish with the per-tree cap and the in-use guard (D5), exit cleanup and the
 * dead-owner staging sweep (D6), and the reader's wait outlasting the budget
 * (D11b).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  promises as fsPromises,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import {
  scheduleWorkingTreeGraphSweep,
  WORKING_TREE_GRAPH_BUILD_TIMEOUT_MS,
  WORKING_TREE_GRAPH_BUILDING_REASON,
  WORKING_TREE_GRAPH_CAP_BYTES,
  WORKING_TREE_GRAPH_CONTENT_READ_CONCURRENCY,
  WORKING_TREE_GRAPH_IDLE_RETENTION_MS,
  WORKING_TREE_GRAPH_SWEEP_DELAY_MS,
  WORKING_TREE_GRAPH_SWEEP_INTERVAL_MS,
  WorkingTreeGraphCache,
  type WorkingTreeGraphBasePool,
  type WorkingTreeGraphCacheDeps,
  type WorkingTreeGraphExitHooks,
} from "../../../../../src/core/api/internal/infra/working-tree-graph-cache.js";
import { WORKING_TREE_GRAPH_WAIT_MS } from "../../../../../src/core/api/internal/infra/working-tree-graph-read.js";
import type { PhysicalCollectionName } from "../../../../../src/core/contracts/types/collection-identity.js";
import type {
  WorkingTreeGraphRequest,
  WorkingTreeGraphState,
} from "../../../../../src/core/contracts/types/working-tree.js";
import type {
  WorkingTreeGraphBuildBudget,
  WorkingTreeGraphBuildInput,
  WorkingTreeGraphBuildOutcome,
} from "../../../../../src/core/domains/trajectory/codegraph/working-tree/index.js";

const COLLECTION = "code_wtg";
const PHYSICAL = fixturePhysicalCollectionName("code_wtg_v2");
const BUDGET: WorkingTreeGraphBuildBudget = { timeoutMs: 120_000, heapLimitMb: 2048 };
const PROVIDER_CONFIG = { languageModulePath: "/lang.js", migrationsModulePath: "/migrations.js" };
const HOUR = 3_600_000;

let scratch: string;
let appRoot: string;
let baseDbRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "wtg-cache-"));
  appRoot = join(scratch, "app", "working-tree");
  baseDbRoot = join(scratch, "base-db");
  writeBaseGraph("base-v1");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function basePath(): string {
  return join(baseDbRoot, "codegraph", `${PHYSICAL}.duckdb`);
}

function writeBaseGraph(content: string): void {
  mkdirSync(dirname(basePath()), { recursive: true });
  writeFileSync(basePath(), content);
}

function treeDir(name: string): string {
  const dir = join(scratch, "trees", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

class FakeBasePool implements WorkingTreeGraphBasePool {
  exports: string[] = [];
  /** Tree graph files a reader of "this process" holds open. */
  openReaders = new Set<string>();
  isFileReaderOpen(dbPath: string): boolean {
    return this.openReaders.has(dbPath);
  }
  hasDatabase(physical: PhysicalCollectionName): boolean {
    return physical === PHYSICAL && existsSync(basePath());
  }
  pathFor(physical: PhysicalCollectionName): string {
    return join(baseDbRoot, "codegraph", `${physical}.duckdb`);
  }
  async exportSnapshot(physical: PhysicalCollectionName, targetPath: string): Promise<void> {
    this.exports.push(targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(this.pathFor(physical)));
  }
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

class FakeBuilder {
  inputs: WorkingTreeGraphBuildInput[] = [];
  budgets: WorkingTreeGraphBuildBudget[] = [];
  gate: Gate | undefined;
  /** Runs inside the build, after the input is recorded and before it finishes. */
  during: ((input: WorkingTreeGraphBuildInput) => void) | undefined;
  outcome: ((input: WorkingTreeGraphBuildInput) => WorkingTreeGraphBuildOutcome) | undefined;
  killed = 0;

  killInFlight(): void {
    this.killed++;
  }

  async build(
    input: WorkingTreeGraphBuildInput,
    budget: WorkingTreeGraphBuildBudget,
  ): Promise<WorkingTreeGraphBuildOutcome> {
    this.inputs.push(input);
    this.budgets.push(budget);
    this.during?.(input);
    if (this.gate) await this.gate.promise;
    if (this.outcome) return this.outcome(input);
    const dbPath = join(input.outputRoot, "codegraph", `${input.physicalCollectionName}.duckdb`);
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, `tree:${input.treeRoot}:${input.changedRelPaths.join(",")}`);
    return {
      kind: "built",
      graph: { dbPath, durationMs: 1, walkedFileCount: 1, deletedFileCount: 0, hierarchyDependentCount: 0 },
    };
  }
}

/** Process-exit hooks under test control: what is registered, and a way to fire it. */
class FakeExitHooks implements WorkingTreeGraphExitHooks {
  readonly active = new Set<() => void>();
  registrations = 0;
  register(onExit: () => void): () => void {
    this.registrations++;
    this.active.add(onExit);
    return () => {
      this.active.delete(onExit);
    };
  }
  fire(): void {
    for (const onExit of [...this.active]) onExit();
  }
}

interface Harness {
  cache: WorkingTreeGraphCache;
  pool: FakeBasePool;
  builder: FakeBuilder;
  clock: { now: number };
  exitHooks: FakeExitHooks;
}

function harness(overrides: Partial<WorkingTreeGraphCacheDeps> = {}, shared?: Partial<Harness>): Harness {
  const pool = shared?.pool ?? new FakeBasePool();
  const builder = shared?.builder ?? new FakeBuilder();
  const clock = shared?.clock ?? { now: 1_000_000 };
  const exitHooks = shared?.exitHooks ?? new FakeExitHooks();
  const cache = new WorkingTreeGraphCache({
    rootDir: appRoot,
    codegraph: () => ({ pool, providerConfig: PROVIDER_CONFIG }),
    resolveActiveCollection: async () => PHYSICAL,
    builder,
    budget: BUDGET,
    now: () => clock.now,
    exitHooks,
    ...overrides,
  });
  return { cache, pool, builder, clock, exitHooks };
}

/**
 * A request over `root`. The key is content-based (D7), so each changed file is
 * written holding the fingerprint: a new fingerprint is new content, the same
 * fingerprint the same bytes. Tests that pin the content rule write files
 * themselves and pass `writeContent: false`.
 */
function request(
  root: string,
  fingerprint = "fp-1",
  changed: string[] = ["src/a.ts"],
  writeContent = true,
): WorkingTreeGraphRequest {
  if (writeContent && existsSync(root)) {
    for (const relPath of changed) {
      mkdirSync(dirname(join(root, relPath)), { recursive: true });
      writeFileSync(join(root, relPath), `content of ${relPath} at ${fingerprint}`);
    }
  }
  return {
    tree: { root, baseIndex: { collectionName: COLLECTION, root: join(scratch, "base-src") } },
    changed,
    deleted: [],
    fingerprint,
  };
}

function graphRoot(): string {
  return join(appRoot, COLLECTION, "graph");
}

function treeEntries(): string[] {
  const dir = join(graphRoot(), "trees");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function snapshotEntries(): string[] {
  const dir = join(graphRoot(), "snapshots");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function expectBuilt(state: WorkingTreeGraphState): string {
  expect(state).toMatchObject({ kind: "built", physicalCollectionName: PHYSICAL });
  if (state.kind !== "built") throw new Error("unreachable");
  return state.dbPath;
}

function defaultBuilt(
  input: WorkingTreeGraphBuildInput,
  content = `tree:${input.treeRoot}`,
): WorkingTreeGraphBuildOutcome {
  const dbPath = join(input.outputRoot, "codegraph", `${input.physicalCollectionName}.duckdb`);
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, content);
  return {
    kind: "built",
    graph: { dbPath, durationMs: 1, walkedFileCount: 1, deletedFileCount: 0, hierarchyDependentCount: 0 },
  };
}

/** Flush microtasks and one macrotask turn, so background work can settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("WorkingTreeGraphCache#graphFor", () => {
  it("builds the tree graph from a base snapshot and publishes it under the tree's key", async () => {
    const { cache, builder, pool } = harness();
    const root = treeDir("t1");

    const dbPath = expectBuilt(await cache.graphFor(request(root), 10_000));

    expect(dbPath.startsWith(join(graphRoot(), "trees"))).toBe(true);
    expect(dbPath.endsWith(join("codegraph", `${PHYSICAL}.duckdb`))).toBe(true);
    expect(readFileSync(dbPath, "utf8")).toBe(`tree:${root}:src/a.ts`);
    expect(builder.inputs).toHaveLength(1);
    const [input] = builder.inputs;
    expect(input).toMatchObject({
      physicalCollectionName: PHYSICAL,
      treeRoot: root,
      changedRelPaths: ["src/a.ts"],
      deletedRelPaths: [],
      providerConfig: PROVIDER_CONFIG,
    });
    expect(dirname(input.snapshotPath)).toBe(join(graphRoot(), "snapshots"));
    expect(input.snapshotPath).toMatch(new RegExp(`/${PHYSICAL}-[0-9a-f]{16}\\.duckdb$`));
    expect(pool.exports).toEqual([input.snapshotPath]);
    expect(builder.budgets).toEqual([BUDGET]);
  });

  it("single-flights one key: two concurrent requests share one build", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");

    const [a, b] = await Promise.all([cache.graphFor(request(root), 10_000), cache.graphFor(request(root), 10_000)]);

    expect(builder.inputs).toHaveLength(1);
    expect(expectBuilt(a)).toBe(expectBuilt(b));
  });

  it("answers `building` when the wait lapses, and the next call joins the same build", async () => {
    const { cache, builder } = harness();
    builder.gate = gate();
    const root = treeDir("t1");

    expect(await cache.graphFor(request(root), 20)).toEqual({
      kind: "unavailable",
      reason: WORKING_TREE_GRAPH_BUILDING_REASON,
    });

    const next = cache.graphFor(request(root), 10_000);
    builder.gate.open();
    expectBuilt(await next);
    expect(builder.inputs).toHaveLength(1);
  });

  it("waitMs 0 is a warm-up: returns at once and the build finishes in the background", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");

    expect(await cache.graphFor(request(root), 0)).toMatchObject({ kind: "unavailable" });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expectBuilt(await cache.graphFor(request(root), 10_000));
    expect(builder.inputs).toHaveLength(1);
  });

  it("reuses a published graph across cache instances (a restarted server) without rebuilding", async () => {
    const first = harness();
    const root = treeDir("t1");
    const dbPath = expectBuilt(await first.cache.graphFor(request(root), 10_000));

    const second = harness();
    expect(expectBuilt(await second.cache.graphFor(request(root), 10_000))).toBe(dbPath);
    expect(second.builder.inputs).toHaveLength(0);
  });

  it("different content (the helper writes each fingerprint into the file) is a different key and a new build", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");

    const a = expectBuilt(await cache.graphFor(request(root, "fp-1"), 10_000));
    const b = expectBuilt(await cache.graphFor(request(root, "fp-2"), 10_000));

    expect(a).not.toBe(b);
    expect(builder.inputs).toHaveLength(2);
  });

  it("remembers a failed build for the backoff, then retries", async () => {
    const { cache, builder, clock } = harness({ failureBackoffMs: 60_000 });
    builder.outcome = () => ({ kind: "failed", reason: "parse exploded" });
    const root = treeDir("t1");

    const first = await cache.graphFor(request(root), 10_000);
    expect(first).toMatchObject({ kind: "unavailable" });
    expect(first.kind === "unavailable" && first.reason).toContain("parse exploded");

    clock.now += 59_000;
    expect(await cache.graphFor(request(root), 10_000)).toEqual(first);
    expect(builder.inputs).toHaveLength(1);

    clock.now += 2_000;
    builder.outcome = undefined;
    expectBuilt(await cache.graphFor(request(root), 10_000));
    expect(builder.inputs).toHaveLength(2);
    expect(treeEntries().filter((name) => name.includes(".staging-"))).toEqual([]);
  });

  it("names a timed-out and a heap-exhausted child in the reason", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");

    builder.outcome = () => ({ kind: "timedOut", timeoutMs: 120_000 });
    const timedOut = await cache.graphFor(request(root, "fp-t"), 10_000);
    expect(timedOut.kind === "unavailable" && timedOut.reason).toMatch(/timed out after 120000 ms/);

    builder.outcome = () => ({ kind: "heapExhausted", heapLimitMb: 2048 });
    const heap = await cache.graphFor(request(root, "fp-h"), 10_000);
    expect(heap.kind === "unavailable" && heap.reason).toMatch(/2048 MB heap/);
  });

  it("a builder that throws is an unavailable answer, never a rejection", async () => {
    const { cache, builder } = harness();
    builder.outcome = () => {
      throw new Error("spawn bug");
    };

    const state = await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(state.kind === "unavailable" && state.reason).toContain("spawn bug");
  });

  it("publishes by rename: while building only a staging dir exists, afterwards only the key dir", async () => {
    const { cache, builder } = harness();
    builder.gate = gate();
    let duringBuild: string[] = [];
    builder.during = () => {
      duringBuild = treeEntries();
    };

    const pending = cache.graphFor(request(treeDir("t1")), 10_000);
    await settle();
    builder.gate.open();
    const dbPath = expectBuilt(await pending);

    expect(duringBuild).toHaveLength(1);
    expect(duringBuild[0]).toMatch(/^[0-9a-f]{64}\.staging-\d+-[0-9a-f]+$/);
    const key = duringBuild[0].split(".staging-")[0];
    expect(treeEntries()).toEqual([key]);
    expect(dbPath.startsWith(join(graphRoot(), "trees", key))).toBe(true);
  });

  it("loses the cross-process race gracefully: a key dir published meanwhile wins, staging is discarded", async () => {
    const { cache, builder } = harness();
    builder.during = (input) => {
      // Another server publishes the same key while this build runs.
      const key = input.outputRoot.split("/").pop()!.split(".staging-")[0];
      const winner = join(graphRoot(), "trees", key);
      mkdirSync(join(winner, "codegraph"), { recursive: true });
      writeFileSync(join(winner, "codegraph", `${PHYSICAL}.duckdb`), "winner");
      writeFileSync(
        join(winner, "tree-graph.meta.json"),
        JSON.stringify({
          treeRoot: input.treeRoot,
          publishedAt: 1,
          physicalCollectionName: PHYSICAL,
          dbRelPath: join("codegraph", `${PHYSICAL}.duckdb`),
        }),
      );
    };

    const dbPath = expectBuilt(await cache.graphFor(request(treeDir("t1")), 10_000));

    expect(readFileSync(dbPath, "utf8")).toBe("winner");
    expect(treeEntries()).toHaveLength(1);
    expect(treeEntries()[0]).not.toContain(".staging-");
  });

  it("exports one snapshot per base version: shared across trees, re-exported when the base moves", async () => {
    const { cache, pool } = harness();

    await cache.graphFor(request(treeDir("t1")), 10_000);
    await cache.graphFor(request(treeDir("t2")), 10_000);
    expect(pool.exports).toHaveLength(1);
    const [firstSnapshot] = pool.exports;

    writeBaseGraph("base-v2-is-longer");
    await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(pool.exports).toHaveLength(2);
    expect(pool.exports[1]).not.toBe(firstSnapshot);
    // The superseded version is kept through its grace (another process's build
    // may have just picked it) and goes at the first sweep past it.
    expect(snapshotEntries()).toEqual([firstSnapshot, pool.exports[1]].map((p) => p.split("/").pop()).sort());
    await cache.sweep(Date.now() + HOUR);
    expect(snapshotEntries()).toEqual([pool.exports[1].split("/").pop()]);
  });

  it("retries once when its snapshot vanished mid-build (a concurrent sweep), re-exporting it", async () => {
    const { cache, builder, pool } = harness();
    let calls = 0;
    builder.during = (input) => {
      calls++;
      if (calls === 1) rmSync(input.snapshotPath);
    };
    builder.outcome = (input) =>
      existsSync(input.snapshotPath) ? defaultBuilt(input, "retried") : { kind: "failed", reason: "snapshot ENOENT" };

    const dbPath = expectBuilt(await cache.graphFor(request(treeDir("t1")), 10_000));

    expect(readFileSync(dbPath, "utf8")).toBe("retried");
    expect(builder.inputs).toHaveLength(2);
    expect(pool.exports).toHaveLength(2);
    expect(existsSync(builder.inputs[1].snapshotPath)).toBe(true);
  });

  it("the retry re-resolves the base version when the base moved meanwhile", async () => {
    const { cache, builder } = harness();
    let calls = 0;
    builder.during = (input) => {
      calls++;
      if (calls !== 1) return;
      rmSync(input.snapshotPath);
      writeBaseGraph("base-moved-to-a-new-version");
    };
    builder.outcome = (input) =>
      existsSync(input.snapshotPath) ? defaultBuilt(input) : { kind: "failed", reason: "gone" };

    expectBuilt(await cache.graphFor(request(treeDir("t1")), 10_000));

    expect(builder.inputs).toHaveLength(2);
    expect(builder.inputs[1].snapshotPath).not.toBe(builder.inputs[0].snapshotPath);
  });

  it("retries only once: a snapshot that vanishes again is a remembered failure", async () => {
    const { cache, builder } = harness();
    builder.during = (input) => {
      rmSync(input.snapshotPath);
    };
    builder.outcome = () => ({ kind: "failed", reason: "gone" });

    const state = await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(state).toMatchObject({ kind: "unavailable" });
    expect(builder.inputs).toHaveLength(2);
    expect(await cache.graphFor(request(treeDir("t1")), 10_000)).toEqual(state);
    expect(builder.inputs).toHaveLength(2);
  });

  it("a failure whose snapshot is still there is not retried", async () => {
    const { cache, builder } = harness();
    builder.outcome = () => ({ kind: "failed", reason: "real failure" });

    await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(builder.inputs).toHaveLength(1);
  });

  it("addresses the physical collection for the graph and the alias for the storage dir", async () => {
    const resolved: string[] = [];
    const { cache, builder } = harness({
      resolveActiveCollection: async (name) => {
        resolved.push(name);
        return PHYSICAL;
      },
    });

    await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(resolved).toEqual([COLLECTION]);
    expect(builder.inputs[0].snapshotPath.startsWith(join(appRoot, COLLECTION))).toBe(true);
    expect(builder.inputs[0].physicalCollectionName).toBe(PHYSICAL);
  });

  it("is unavailable, without building, when the base has no graph", async () => {
    const { cache, builder } = harness();
    rmSync(basePath());

    const state = await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(state).toMatchObject({ kind: "unavailable" });
    expect(builder.inputs).toHaveLength(0);
  });

  it("is unavailable when codegraph is off", async () => {
    const { cache, builder } = harness({ codegraph: () => undefined });

    expect(await cache.graphFor(request(treeDir("t1")), 10_000)).toMatchObject({ kind: "unavailable" });
    expect(builder.inputs).toHaveLength(0);
  });

  it("is unavailable for an empty delta — a clean tree reads the base graph", async () => {
    const { cache, builder } = harness();

    expect(await cache.graphFor(request(treeDir("t1"), "fp", []), 10_000)).toMatchObject({ kind: "unavailable" });
    expect(builder.inputs).toHaveLength(0);
  });

  it("refuses a collection name that is not one path segment", async () => {
    const { cache, builder } = harness();
    const req = request(treeDir("t1"));

    const state = await cache.graphFor(
      { ...req, tree: { ...req.tree, baseIndex: { collectionName: "../x", root: undefined } } },
      10_000,
    );

    expect(state).toMatchObject({ kind: "unavailable" });
    expect(builder.inputs).toHaveLength(0);
    expect(existsSync(join(scratch, "app", "x"))).toBe(false);
  });
});

describe("WorkingTreeGraphCache#sweep", () => {
  it("evicts a dead tree's graphs, all but the newest graph per tree, superseded snapshots and old staging", async () => {
    const { cache, clock } = harness();
    const live = treeDir("live");
    const dead = treeDir("dead");

    // Published just before the sweep: a graph unserved for 96 h goes too (B2),
    // so the newest must be recent on the sweep's own (wall) clock.
    clock.now = Date.now() - 2 * HOUR;
    const older = expectBuilt(await cache.graphFor(request(live, "fp-old"), 10_000));
    clock.now = Date.now() - HOUR;
    const newer = expectBuilt(await cache.graphFor(request(live, "fp-new"), 10_000));
    const deadGraph = expectBuilt(await cache.graphFor(request(dead, "fp"), 10_000));
    rmSync(dead, { recursive: true });

    const [currentSnapshot] = snapshotEntries();
    // A snapshot of a base version that has since moved, never re-exported.
    const supersededSnapshot = join(graphRoot(), "snapshots", `${PHYSICAL}-0123456789abcdef.duckdb`);
    writeFileSync(supersededSnapshot, "old");
    const sweepAtForAge = Date.now();
    const longAgo = new Date(sweepAtForAge - 2 * HOUR);
    utimesSync(supersededSnapshot, longAgo, longAgo);

    const trees = join(graphRoot(), "trees");
    const oldStaging = join(trees, `${"a".repeat(64)}.staging-1-ab`);
    // Owned by a live process (this one): only age can retire it. A dead
    // owner's staging goes at once (D6), whatever its age.
    const freshStaging = join(trees, `${"b".repeat(64)}.staging-${String(process.pid)}-cd`);
    mkdirSync(oldStaging);
    mkdirSync(freshStaging);
    const sweepAt = Date.now();
    const twoHoursAgo = new Date(sweepAt - 2 * HOUR);
    utimesSync(oldStaging, twoHoursAgo, twoHoursAgo);

    // A chunk-store entry beside the graph dir is not the graph cache's to touch.
    const chunkMeta = join(appRoot, COLLECTION, "deadbeef.meta.json");
    writeFileSync(chunkMeta, "{}");

    const result = await cache.sweep(sweepAt);

    expect(existsSync(newer)).toBe(true);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(deadGraph)).toBe(false);
    expect(snapshotEntries()).toEqual([currentSnapshot]);
    expect(existsSync(oldStaging)).toBe(false);
    expect(existsSync(freshStaging)).toBe(true);
    expect(existsSync(chunkMeta)).toBe(true);
    expect(result).toEqual({ evictedGraphs: 2, evictedSnapshots: 1, evictedStaging: 1, keptGraphs: 1 });
  });

  it("evicts every snapshot once the base graph is gone", async () => {
    const { cache } = harness();
    await cache.graphFor(request(treeDir("t1")), 10_000);
    rmSync(basePath());

    await cache.sweep(Date.now() + HOUR);

    expect(snapshotEntries()).toEqual([]);
  });

  it("keeps a superseded snapshot younger than the grace — a build elsewhere may have just picked it", async () => {
    const { cache } = harness();
    await cache.graphFor(request(treeDir("t1")), 10_000);
    const superseded = join(graphRoot(), "snapshots", `${PHYSICAL}-0123456789abcdef.duckdb`);
    writeFileSync(superseded, "old");
    const at = Date.now();
    const fiveMinutesAgo = new Date(at - 5 * 60_000);
    utimesSync(superseded, fiveMinutesAgo, fiveMinutesAgo);

    expect((await cache.sweep(at)).evictedSnapshots).toBe(0);
    expect(existsSync(superseded)).toBe(true);

    expect((await cache.sweep(at + 6 * 60_000)).evictedSnapshots).toBe(1);
    expect(existsSync(superseded)).toBe(false);
  });

  it("keeps the older graph of a tree for the grace after the newer one is published — a reader may hold it", async () => {
    const { cache, clock } = harness();
    const root = treeDir("t1");
    clock.now = 10 * HOUR;
    const older = expectBuilt(await cache.graphFor(request(root, "fp-old"), 10_000));
    clock.now = 20 * HOUR;
    const newer = expectBuilt(await cache.graphFor(request(root, "fp-new"), 10_000));

    expect(await cache.sweep(20 * HOUR + 5 * 60_000)).toMatchObject({ evictedGraphs: 0, keptGraphs: 2 });
    expect(existsSync(older)).toBe(true);

    expect(await cache.sweep(20 * HOUR + 11 * 60_000)).toMatchObject({ evictedGraphs: 1, keptGraphs: 1 });
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });

  it("is a no-op on an empty root", async () => {
    const { cache } = harness();

    expect(await cache.sweep(Date.now())).toEqual({
      evictedGraphs: 0,
      evictedSnapshots: 0,
      evictedStaging: 0,
      keptGraphs: 0,
    });
  });
});

/** The published key dirs (no staging) whose meta names `root`. */
function graphsOf(root: string): string[] {
  return treeEntries().filter((name) => {
    if (name.includes(".staging-")) return false;
    const meta = join(graphRoot(), "trees", name, "tree-graph.meta.json");
    return existsSync(meta) && (JSON.parse(readFileSync(meta, "utf8")) as { treeRoot: string }).treeRoot === root;
  });
}

/** A pid that certainly belongs to no running process: a child that has already exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) throw new Error("spawnSync gave no pid");
  return pid;
}

describe("WorkingTreeGraphCache — content-based key (D7)", () => {
  it("reverting a file to identical bytes reuses the published graph instead of rebuilding", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    const file = join(root, "src", "a.ts");
    mkdirSync(dirname(file), { recursive: true });

    writeFileSync(file, "export const a = 1;\n");
    const original = expectBuilt(await cache.graphFor(request(root, "fp-original", ["src/a.ts"], false), 10_000));
    clock.now += 1_000;
    writeFileSync(file, "export const a = 2;\n");
    const edited = expectBuilt(await cache.graphFor(request(root, "fp-edited", ["src/a.ts"], false), 10_000));
    clock.now += 1_000;
    // Same bytes, a fresh mtime and a new delta fingerprint — what a revert looks like.
    writeFileSync(file, "export const a = 1;\n");
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const reverted = expectBuilt(await cache.graphFor(request(root, "fp-reverted", ["src/a.ts"], false), 10_000));

    expect(edited).not.toBe(original);
    expect(reverted).toBe(original);
    expect(builder.inputs).toHaveLength(2);
  });

  it("the delete set is part of the key", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");
    const req = request(root, "fp");

    const withoutDelete = expectBuilt(await cache.graphFor(req, 10_000));
    const withDelete = expectBuilt(await cache.graphFor({ ...req, deleted: ["src/gone.ts"] }, 10_000));

    expect(withDelete).not.toBe(withoutDelete);
    expect(builder.inputs).toHaveLength(2);
  });

  it("the order the delta lists its files in does not move the key", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");
    request(root, "fp", ["src/a.ts", "src/b.ts"]);

    const ab = expectBuilt(await cache.graphFor(request(root, "fp-x", ["src/a.ts", "src/b.ts"], false), 10_000));
    const ba = expectBuilt(await cache.graphFor(request(root, "fp-y", ["src/b.ts", "src/a.ts"], false), 10_000));

    expect(ba).toBe(ab);
    expect(builder.inputs).toHaveLength(1);
  });
});

describe("WorkingTreeGraphCache — content-hash memo bounded in bytes (WTO unbounded delta)", () => {
  /** Content reads of files under `root` while `run` runs: the memo's misses. */
  async function contentReadsUnder(root: string, run: () => Promise<unknown>): Promise<number> {
    const readFile = vi.spyOn(fsPromises, "readFile");
    try {
      await run();
      return readFile.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(root)).length;
    } finally {
      readFile.mockRestore();
    }
  }

  it("keeps the hashes of a 5,000-file delta under the default bound: re-asking it reads no file", async () => {
    const { cache } = harness();
    const root = treeDir("t1");
    const changed = Array.from({ length: 5_000 }, (_, i) => `src/f${String(i)}.ts`);
    expectBuilt(await cache.graphFor(request(root, "fp-1", changed), 60_000));

    const reads = await contentReadsUnder(root, async () =>
      cache.graphFor(request(root, "fp-2", changed, false), 60_000),
    );

    expect(reads).toBe(0);
  });

  // The delta has no file cap: one read per changed file all at once ran out
  // of descriptors (EMFILE) at tens of thousands of files.
  it("reads at most the content-read cap of a delta's files at once", async () => {
    const { cache } = harness();
    const root = treeDir("t1");
    const changed = Array.from({ length: 300 }, (_, i) => `src/f${String(i)}.ts`);
    const original = fsPromises.readFile.bind(fsPromises);
    let inFlight = 0;
    let peak = 0;
    const readFile = vi
      .spyOn(fsPromises, "readFile")
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        const under = typeof args[0] === "string" && args[0].startsWith(root);
        if (under) peak = Math.max(peak, ++inFlight);
        try {
          if (under) await new Promise((resolve) => setTimeout(resolve, 1));
          return await original(...args);
        } finally {
          if (under) inFlight--;
        }
      });
    try {
      expectBuilt(await cache.graphFor(request(root, "fp-1", changed), 60_000));
    } finally {
      readFile.mockRestore();
    }

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(WORKING_TREE_GRAPH_CONTENT_READ_CONCURRENCY);
  });

  // A view asks twice per request — the warm-up `graphFor(request, 0)` and the
  // read — and a 3,435-file delta digest cost 1.7-1.9 s live: overlapping asks
  // of one delta share one digest.
  it("digests a delta once for overlapping asks of the same delta", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");
    const changed = Array.from({ length: 20 }, (_, i) => `src/f${String(i)}.ts`);
    const ask = request(root, "fp-1", changed);
    const stat = vi.spyOn(fsPromises, "stat");
    try {
      const [warmUp, read] = await Promise.all([
        cache.graphFor(ask, 60_000),
        cache.graphFor(request(root, "fp-1", [...changed].reverse(), false), 60_000),
      ]);
      expect(expectBuilt(read)).toBe(expectBuilt(warmUp));
      const treeStats = stat.mock.calls.filter(
        ([path]) => typeof path === "string" && path.startsWith(join(root, "src")),
      );
      expect(treeStats).toHaveLength(changed.length);
    } finally {
      stat.mockRestore();
    }
    expect(builder.inputs).toHaveLength(1);
  });

  it("does not keep a hash larger than `contentHashMemoBytes`: every request re-reads the file", async () => {
    const { cache } = harness({ contentHashMemoBytes: 1 });
    const root = treeDir("t1");
    expectBuilt(await cache.graphFor(request(root, "fp-1"), 10_000));

    const reads = await contentReadsUnder(root, async () =>
      cache.graphFor(request(root, "fp-2", ["src/a.ts"], false), 10_000),
    );

    expect(reads).toBe(1);
  });
});

describe("WorkingTreeGraphCache — retention after each publish (D5)", () => {
  it("a burst of edits keeps at most two graphs per tree, without waiting for the periodic sweep", async () => {
    const { cache, clock } = harness();
    const root = treeDir("t1");

    for (let edit = 0; edit < 10; edit++) {
      clock.now += 1_000;
      expectBuilt(await cache.graphFor(request(root, `fp-${String(edit)}`), 10_000));
      expect(graphsOf(root).length).toBeLessThanOrEqual(2);
    }
    expect(graphsOf(root)).toHaveLength(2);
  });

  it("a graph served again (a revert) is the tree's newest for retention, so the next edit keeps it", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    const file = join(root, "src", "a.ts");
    mkdirSync(dirname(file), { recursive: true });
    const ask = async (content: string, fingerprint: string): Promise<string> => {
      clock.now += 1_000;
      writeFileSync(file, content);
      return expectBuilt(await cache.graphFor(request(root, fingerprint, ["src/a.ts"], false), 10_000));
    };

    const original = await ask("original", "fp-1");
    const edited = await ask("edited", "fp-2");
    expect(await ask("original", "fp-3")).toBe(original);
    await ask("same-size edit", "fp-4");

    expect(existsSync(original)).toBe(true);
    expect(existsSync(edited)).toBe(false);
    expect(await ask("original", "fp-5")).toBe(original);
    expect(builder.inputs).toHaveLength(3);
  });

  it("ages an older graph from the publish of the graph that superseded it", async () => {
    const { cache, clock } = harness();
    const root = treeDir("t1");
    clock.now = 10 * HOUR;
    const first = expectBuilt(await cache.graphFor(request(root, "fp-1"), 10_000));
    clock.now = 10 * HOUR + 60_000;
    const second = expectBuilt(await cache.graphFor(request(root, "fp-2"), 10_000));
    expect(existsSync(first)).toBe(true);

    // 11 min after the second superseded it, the first is past the grace.
    expect(await cache.sweep(10 * HOUR + 12 * 60_000)).toMatchObject({ evictedGraphs: 1 });

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });

  it("never deletes a graph a reader of this process holds open", async () => {
    const { cache, pool, clock } = harness();
    const root = treeDir("t1");
    clock.now += 1_000;
    const held = expectBuilt(await cache.graphFor(request(root, "fp-1"), 10_000));
    pool.openReaders.add(held);

    for (let edit = 2; edit <= 4; edit++) {
      clock.now += 1_000;
      expectBuilt(await cache.graphFor(request(root, `fp-${String(edit)}`), 10_000));
    }
    expect(existsSync(held)).toBe(true);
    expect(graphsOf(root)).toHaveLength(3);

    pool.openReaders.delete(held);
    clock.now += 1_000;
    expectBuilt(await cache.graphFor(request(root, "fp-5"), 10_000));
    expect(existsSync(held)).toBe(false);
    expect(graphsOf(root)).toHaveLength(2);
  });

  it("the periodic sweep honours the same cap and in-use rule", async () => {
    const { cache, pool, clock } = harness();
    const root = treeDir("t1");
    const built: string[] = [];
    for (let edit = 0; edit < 2; edit++) {
      clock.now += 1_000;
      built.push(expectBuilt(await cache.graphFor(request(root, `fp-${String(edit)}`), 10_000)));
    }
    // Two graphs published by another server land beside them — one old, one
    // older — and a reader of this process holds the oldest open.
    const foreignGraph = (name: string, publishedAt: number): string => {
      const dir = join(graphRoot(), "trees", name.repeat(64));
      mkdirSync(join(dir, "codegraph"), { recursive: true });
      writeFileSync(join(dir, "codegraph", `${PHYSICAL}.duckdb`), "foreign");
      writeFileSync(
        join(dir, "tree-graph.meta.json"),
        JSON.stringify({
          treeRoot: root,
          publishedAt,
          physicalCollectionName: PHYSICAL,
          dbRelPath: join("codegraph", `${PHYSICAL}.duckdb`),
        }),
      );
      return dir;
    };
    const old = foreignGraph("e", 2);
    const held = foreignGraph("f", 1);
    pool.openReaders.add(join(held, "codegraph", `${PHYSICAL}.duckdb`));

    await cache.sweep(clock.now);

    expect(existsSync(built[1])).toBe(true);
    expect(existsSync(built[0])).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(held)).toBe(true);
  });

  it("leaves other trees' graphs alone", async () => {
    const { cache, clock } = harness();
    const other = treeDir("other");
    const root = treeDir("t1");
    const otherGraph = expectBuilt(await cache.graphFor(request(other, "fp"), 10_000));

    for (let edit = 0; edit < 4; edit++) {
      clock.now += 1_000;
      expectBuilt(await cache.graphFor(request(root, `fp-${String(edit)}`), 10_000));
    }

    expect(existsSync(otherGraph)).toBe(true);
  });

  it("keeps at most the live snapshot and one superseded one after a publish", async () => {
    const { cache, pool } = harness();
    const root = treeDir("t1");

    for (const [i, base] of ["base-a", "base-bb", "base-ccc", "base-dddd"].entries()) {
      writeBaseGraph(base);
      expectBuilt(await cache.graphFor(request(root, `fp-${String(i)}`), 10_000));
      expect(snapshotEntries().length).toBeLessThanOrEqual(2);
    }
    expect(pool.exports).toHaveLength(4);
    expect(snapshotEntries()).toContain(pool.exports[3].split("/").pop());
  });
});

describe("WorkingTreeGraphCache — process exit (D6)", () => {
  it("holds an exit hook only while a build runs", async () => {
    const { cache, builder, exitHooks } = harness();
    builder.gate = gate();

    const pending = cache.graphFor(request(treeDir("t1")), 10_000);
    await settle();
    expect(exitHooks.active.size).toBe(1);

    builder.gate.open();
    expectBuilt(await pending);
    expect(exitHooks.active.size).toBe(0);
  });

  it("at exit, kills the build child and removes this process's staging dir synchronously", async () => {
    const { cache, builder, exitHooks } = harness();
    builder.gate = gate();
    let staging = "";
    builder.during = (input) => {
      staging = input.outputRoot;
    };

    const pending = cache.graphFor(request(treeDir("t1")), 10_000);
    while (builder.inputs.length === 0) await settle();
    expect(existsSync(staging)).toBe(true);

    exitHooks.fire();

    expect(builder.killed).toBe(1);
    expect(existsSync(staging)).toBe(false);
    builder.outcome = () => ({ kind: "failed", reason: "killed at exit" });
    builder.gate.open();
    expect(await pending).toMatchObject({ kind: "unavailable" });
  });

  it("the sweep removes a staging dir whose owner process is dead at once, and keeps a live owner's", async () => {
    const { cache } = harness();
    const trees = join(graphRoot(), "trees");
    mkdirSync(trees, { recursive: true });
    const orphan = join(trees, `${"a".repeat(64)}.staging-${String(deadPid())}-ab12`);
    const liveOwner = join(trees, `${"b".repeat(64)}.staging-${String(process.ppid)}-cd34`);
    mkdirSync(orphan);
    mkdirSync(liveOwner);

    const result = await cache.sweep(Date.now());

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(liveOwner)).toBe(true);
    expect(result.evictedStaging).toBe(1);
  });

  // bd tea-rags-mcp-xi2r9, B1: a `servedAt` or sweep-stamp write cut by process
  // exit strands its temp; the temp names the writer's pid, so the next sweep
  // removes a dead writer's at once — inside a published key dir too.
  it("the sweep removes the meta and stamp temps a dead writer stranded, and keeps the graph", async () => {
    const { cache } = harness();
    const dbPath = expectBuilt(await cache.graphFor(request(treeDir("t1")), 10_000));
    const [keyName] = treeEntries();
    const keyDir = join(graphRoot(), "trees", keyName);
    const dead = String(deadPid());
    writeFileSync(join(keyDir, `tree-graph.meta.json.${dead}.0badf00d.tmp`), "");
    writeFileSync(join(appRoot, `.graph-sweep-stamp.json.${dead}.0badf00d.tmp`), "");

    await cache.sweep(1_000_000);

    expect(readdirSync(keyDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(appRoot).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("WorkingTreeGraphCache — the reader's wait (D11b)", () => {
  it("a graph tool waits longer than the build budget, so a build that runs out reports why", () => {
    expect(WORKING_TREE_GRAPH_WAIT_MS).toBeGreaterThan(WORKING_TREE_GRAPH_BUILD_TIMEOUT_MS);
  });

  it("a wait that lapses in the same turn the build ends reports the build's outcome, not `building`", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const progress = { started: false };
      const { cache } = harness({
        builder: {
          build: async (_input, budget) => {
            progress.started = true;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { kind: "timedOut", timeoutMs: budget.timeoutMs };
          },
        },
      });

      const pending = cache.graphFor(request(treeDir("t1")), 100);
      while (!progress.started) await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(100);
      const state = await pending;

      expect(state.kind === "unavailable" && state.reason).toMatch(/timed out after 120000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Retention across trees (live round-4 B2): per-tree retention kept the store
 * bounded per tree, but the graphs of an idle tree — one no server has served
 * for days — stayed forever, so the store grew with every tree ever read (16
 * graphs of 14.6–18.7 MB for 14 tree roots on one collection). A graph unserved
 * for {@link WORKING_TREE_GRAPH_IDLE_RETENTION_MS} goes; a collection's graphs
 * fit a byte cap, least-recently-active first; neither ever deletes a graph a
 * reader of this process holds open. A snapshot unused for as long goes too.
 * The sweep runs off the request path: first after two minutes, then every six
 * hours, throttled across processes by a stamp.
 */
describe("WorkingTreeGraphCache — retention across trees (B2)", () => {
  it("evicts a live tree's graph unserved for the idle retention, and keeps one served within it", async () => {
    const { cache, clock } = harness();
    clock.now = 10 * HOUR;
    const idle = expectBuilt(await cache.graphFor(request(treeDir("idle"), "fp"), 10_000));
    clock.now = 12 * HOUR;
    const recent = expectBuilt(await cache.graphFor(request(treeDir("recent"), "fp"), 10_000));

    const result = await cache.sweep(10 * HOUR + WORKING_TREE_GRAPH_IDLE_RETENTION_MS + 60_000);

    expect(existsSync(idle)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(result).toMatchObject({ evictedGraphs: 1, keptGraphs: 1 });
  });

  it("a graph served again later counts as active from then, not from its publish", async () => {
    const { cache, clock } = harness();
    const root = treeDir("t1");
    clock.now = 10 * HOUR;
    const graph = expectBuilt(await cache.graphFor(request(root, "fp"), 10_000));
    clock.now = 50 * HOUR;
    expect(expectBuilt(await cache.graphFor(request(root, "fp"), 10_000))).toBe(graph);

    await cache.sweep(10 * HOUR + WORKING_TREE_GRAPH_IDLE_RETENTION_MS + 60_000);

    expect(existsSync(graph)).toBe(true);
  });

  it("never evicts an idle graph a reader of this process holds open", async () => {
    const { cache, pool, clock } = harness();
    clock.now = 10 * HOUR;
    const held = expectBuilt(await cache.graphFor(request(treeDir("t1"), "fp"), 10_000));
    pool.openReaders.add(held);

    await cache.sweep(10 * HOUR + 2 * WORKING_TREE_GRAPH_IDLE_RETENTION_MS);

    expect(existsSync(held)).toBe(true);
  });

  it("fits a collection's graphs into the byte cap, least-recently-active first, skipping an open one", async () => {
    const { cache, pool, builder, clock } = harness({ capBytes: 2_700 });
    builder.outcome = (input) => defaultBuilt(input, "x".repeat(1_000));
    const built: string[] = [];
    for (const name of ["a", "b", "c", "d"]) {
      clock.now += 60_000;
      built.push(expectBuilt(await cache.graphFor(request(treeDir(name), "fp"), 10_000)));
    }
    pool.openReaders.add(built[0]);

    await cache.sweep(clock.now);

    // ~1.25 KB each: the open oldest stays, then the oldest go until the rest fits.
    expect(built.map((dbPath) => existsSync(dbPath))).toEqual([true, false, false, true]);
  });

  it("evicts the live snapshot once no build used it for the idle retention", async () => {
    const { cache } = harness();
    await cache.graphFor(request(treeDir("t1")), 10_000);
    const [snapshot] = snapshotEntries();
    const path = join(graphRoot(), "snapshots", snapshot);
    const at = Date.now();
    const unused = new Date(at - WORKING_TREE_GRAPH_IDLE_RETENTION_MS - 60_000);
    utimesSync(path, unused, unused);

    expect((await cache.sweep(at)).evictedSnapshots).toBe(1);
    expect(snapshotEntries()).toEqual([]);
  });

  it("a build that reuses the live snapshot marks it used, so the idle rule keeps it", async () => {
    const { cache } = harness();
    await cache.graphFor(request(treeDir("t1")), 10_000);
    const [snapshot] = snapshotEntries();
    const path = join(graphRoot(), "snapshots", snapshot);
    const at = Date.now();
    const unused = new Date(at - WORKING_TREE_GRAPH_IDLE_RETENTION_MS - 60_000);
    utimesSync(path, unused, unused);

    await cache.graphFor(request(treeDir("t2")), 10_000);

    expect((await cache.sweep(at)).evictedSnapshots).toBe(0);
    expect(snapshotEntries()).toEqual([snapshot]);
  });

  it("sweepIfDue is throttled across processes by a stamp in the root", async () => {
    const { cache, clock } = harness();
    clock.now = 10 * HOUR;
    await cache.graphFor(request(treeDir("t1")), 10_000);
    const other = harness({}, { clock }).cache;
    const sweep = vi.spyOn(other, "sweep");

    expect(await cache.sweepIfDue(20 * HOUR, { intervalMs: 6 * HOUR })).toBeDefined();
    expect(await other.sweepIfDue(21 * HOUR, { intervalMs: 6 * HOUR })).toBeUndefined();
    expect(sweep).not.toHaveBeenCalled();
    expect(await other.sweepIfDue(27 * HOUR, { intervalMs: 6 * HOUR })).toBeDefined();
  });

  it("sweepIfDue on a root that does not exist creates nothing", async () => {
    const { cache } = harness();

    expect(await cache.sweepIfDue(Date.now())).toBeUndefined();
    expect(existsSync(appRoot)).toBe(false);
  });

  it("the schedule never sweeps at start: first after the delay, then every interval", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const sweepIfDue = vi.fn(async () => undefined);
      const stop = scheduleWorkingTreeGraphSweep({ sweepIfDue }, { initialDelayMs: 2 * 60_000, intervalMs: 6 * HOUR });

      expect(sweepIfDue).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2 * 60_000 - 1);
      expect(sweepIfDue).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(sweepIfDue).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(6 * HOUR);
      expect(sweepIfDue).toHaveBeenCalledTimes(2);

      stop();
      vi.advanceTimersByTime(12 * HOUR);
      expect(sweepIfDue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults: the first sweep waits two minutes, the interval is six hours, idle is 96 h, the cap 2 GiB", () => {
    expect(WORKING_TREE_GRAPH_SWEEP_DELAY_MS).toBe(2 * 60_000);
    expect(WORKING_TREE_GRAPH_SWEEP_INTERVAL_MS).toBe(6 * HOUR);
    expect(WORKING_TREE_GRAPH_IDLE_RETENTION_MS).toBe(96 * HOUR);
    expect(WORKING_TREE_GRAPH_CAP_BYTES).toBe(2 * 1024 ** 3);
  });
});

describe("WorkingTreeGraphCache — degraded lookups", () => {
  it("an alias lookup that fails falls back to the collection name as the physical one", async () => {
    const { cache, pool, builder } = harness({
      resolveActiveCollection: async () => Promise.reject(new Error("qdrant down")),
    });
    const hasDatabase = vi.spyOn(pool, "hasDatabase");

    const state = await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(hasDatabase).toHaveBeenCalledWith(COLLECTION);
    expect(state).toEqual({ kind: "unavailable", reason: `no base codegraph for ${COLLECTION}` });
    expect(builder.inputs).toHaveLength(0);
  });

  it("a codegraph runtime that throws is an unavailable answer naming the error, never a rejection", async () => {
    const { cache, builder } = harness({
      codegraph: () => {
        throw new Error("pool closed");
      },
    });

    const state = await cache.graphFor(request(treeDir("t1")), 10_000);

    expect(state).toEqual({ kind: "unavailable", reason: "tree graph cache error: pool closed" });
    expect(builder.inputs).toHaveLength(0);
  });

  it("a changed path that is missing or a directory digests as absent content; its later file is a new key", async () => {
    const { cache, builder } = harness();
    const root = treeDir("t1");
    mkdirSync(join(root, "src", "dir"), { recursive: true });
    const req = request(root, "fp", ["src/gone.ts", "src/dir"], false);

    const first = expectBuilt(await cache.graphFor(req, 10_000));
    expect(expectBuilt(await cache.graphFor(req, 10_000))).toBe(first);
    expect(builder.inputs).toHaveLength(1);

    writeFileSync(join(root, "src", "gone.ts"), "now it exists");
    const second = expectBuilt(await cache.graphFor(req, 10_000));

    expect(second).not.toBe(first);
    expect(builder.inputs).toHaveLength(2);
  });
});

describe("WorkingTreeGraphCache — seeded from the tree's previous graph", () => {
  /** A request over files the test wrote itself; `deleted` as given. */
  function requestOf(root: string, changed: string[], deleted: string[] = []): WorkingTreeGraphRequest {
    return { ...request(root, "fp", changed, false), deleted };
  }

  function write(root: string, relPath: string, content: string): void {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }

  it("builds the next state of a tree from its published graph, walking only what changed since", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    write(root, "src/a.ts", "a1");
    write(root, "src/b.ts", "b1");
    const first = expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts", "src/b.ts"], ["src/gone.ts"]), 10_000));

    clock.now += 1_000;
    write(root, "src/b.ts", "b2");
    write(root, "src/c.ts", "c1");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts", "src/b.ts", "src/c.ts"], ["src/gone.ts"]), 10_000));

    expect(builder.inputs).toHaveLength(2);
    expect(builder.inputs[0].seed).toBeUndefined();
    const second = builder.inputs[1];
    // The whole delta still travels — the build falls back to it when the seed is rejected.
    expect(second.changedRelPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(dirname(second.snapshotPath)).toBe(join(graphRoot(), "snapshots"));
    expect(second.seed).toEqual({
      dbPath: first,
      changedRelPaths: ["src/b.ts", "src/c.ts"],
      deletedRelPaths: [],
      heldRelPaths: ["src/a.ts"],
      restoredRelPaths: [],
      seedChangedRelPaths: ["src/a.ts", "src/b.ts"],
      seedDeletedRelPaths: ["src/gone.ts"],
    });
  });

  it("states a revert and a vanished added file against the seed", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    write(root, "src/a.ts", "a1");
    write(root, "src/new.ts", "n1");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts", "src/new.ts"]), 10_000));

    clock.now += 1_000;
    // a.ts is back at base content (out of the delta, still on disk); new.ts is gone.
    rmSync(join(root, "src/new.ts"));
    write(root, "src/z.ts", "z1");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/z.ts"]), 10_000));

    expect(builder.inputs[1].seed).toMatchObject({
      changedRelPaths: ["src/a.ts", "src/z.ts"],
      deletedRelPaths: ["src/new.ts"],
      heldRelPaths: [],
      restoredRelPaths: ["src/a.ts"],
    });
  });

  it("does not seed from a graph of another base version, nor from another tree's graph", async () => {
    const { cache, builder, clock } = harness();
    const other = treeDir("other");
    const root = treeDir("t1");
    write(other, "src/a.ts", "a1");
    expectBuilt(await cache.graphFor(requestOf(other, ["src/a.ts"]), 10_000));
    write(root, "src/a.ts", "a1");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));
    expect(builder.inputs[1].seed).toBeUndefined();

    clock.now += 1_000;
    writeBaseGraph("base-v2-moved");
    write(root, "src/a.ts", "a2");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));
    expect(builder.inputs[2].seed).toBeUndefined();
  });

  it("does not seed from a published graph that recorded no delta", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    write(root, "src/a.ts", "a1");
    const first = expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));
    const metaPath = join(dirname(dirname(first)), "tree-graph.meta.json");
    const { delta: _delta, ...legacy } = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify(legacy));

    clock.now += 1_000;
    write(root, "src/a.ts", "a2");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));

    expect(builder.inputs[1].seed).toBeUndefined();
  });

  it("publishes the seed's graph under the new key, without a build, when nothing differs from it", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    write(root, "src/a.ts", "a1");
    const first = expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"], ["src/gone.ts"]), 10_000));

    // gone.ts leaves the delta but is not on disk: the tree is the seed's tree.
    clock.now += 1_000;
    const second = expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));

    expect(second).not.toBe(first);
    expect(builder.inputs).toHaveLength(1);
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
    // The republished graph seeds the next build with its own delta.
    clock.now += 1_000;
    write(root, "src/a.ts", "a2");
    expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));
    expect(builder.inputs[1].seed).toMatchObject({ dbPath: second, seedDeletedRelPaths: [] });
  });

  it("holds the seed against the sweep while its build runs", async () => {
    const { cache, builder, clock } = harness();
    const root = treeDir("t1");
    write(root, "src/a.ts", "a1");
    const seedDb = expectBuilt(await cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000));

    clock.now += 1_000;
    builder.gate = gate();
    const started = gate();
    builder.during = () => {
      started.open();
    };
    write(root, "src/a.ts", "a2");
    const pending = cache.graphFor(requestOf(root, ["src/a.ts"]), 10_000);
    await started.promise;
    expect(builder.inputs[1].seed?.dbPath).toBe(seedDb);

    // Idle past the retention: without the hold, the seed is evicted mid-build.
    await cache.sweep(clock.now + 2 * WORKING_TREE_GRAPH_IDLE_RETENTION_MS);
    expect(existsSync(seedDb)).toBe(true);

    builder.gate.open();
    expectBuilt(await pending);
    await cache.sweep(clock.now + 2 * WORKING_TREE_GRAPH_IDLE_RETENTION_MS);
    expect(existsSync(seedDb)).toBe(false);
  });
});
