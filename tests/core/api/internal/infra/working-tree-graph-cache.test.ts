/**
 * WorkingTreeGraphCache (bd tea-rags-mcp-xi2r9, WTO-7 T12): the tree graph's
 * build scheduling and on-disk lifecycle, against a fake builder and a fake
 * base pool in a temp appData. What is pinned: one build per key in-process,
 * the caller's wait budget, the failure backoff, publish-by-rename (no reader
 * ever sees a half-built key dir), the cross-process race, the snapshot's
 * per-base-version reuse, and the sweep's retention matrix.
 */
import {
  existsSync,
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import {
  WORKING_TREE_GRAPH_BUILDING_REASON,
  WorkingTreeGraphCache,
  type WorkingTreeGraphBasePool,
  type WorkingTreeGraphCacheDeps,
} from "../../../../../src/core/api/internal/infra/working-tree-graph-cache.js";
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

interface Harness {
  cache: WorkingTreeGraphCache;
  pool: FakeBasePool;
  builder: FakeBuilder;
  clock: { now: number };
}

function harness(overrides: Partial<WorkingTreeGraphCacheDeps> = {}, shared?: Partial<Harness>): Harness {
  const pool = shared?.pool ?? new FakeBasePool();
  const builder = shared?.builder ?? new FakeBuilder();
  const clock = shared?.clock ?? { now: 1_000_000 };
  const cache = new WorkingTreeGraphCache({
    rootDir: appRoot,
    codegraph: () => ({ pool, providerConfig: PROVIDER_CONFIG }),
    resolveActiveCollection: async () => PHYSICAL,
    builder,
    budget: BUDGET,
    now: () => clock.now,
    ...overrides,
  });
  return { cache, pool, builder, clock };
}

function request(root: string, fingerprint = "fp-1", changed: string[] = ["src/a.ts"]): WorkingTreeGraphRequest {
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

  it("a different fingerprint is a different key and a new build", async () => {
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

    clock.now = 1_000;
    const older = expectBuilt(await cache.graphFor(request(live, "fp-old"), 10_000));
    clock.now = 2_000;
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
    const freshStaging = join(trees, `${"b".repeat(64)}.staging-2-cd`);
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
