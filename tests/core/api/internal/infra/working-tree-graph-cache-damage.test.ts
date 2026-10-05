/**
 * WorkingTreeGraphCache against a damaged or shifting disk: a base graph that
 * vanishes after the pool vouched for it, a cache with no active-collection
 * resolver, and a sweep meeting strays — a file among the key dirs, a key dir
 * whose meta is gone, a snapshot export cut mid-write. The cache answers
 * `unavailable` rather than throwing, and the sweep reclaims only what is
 * provably abandoned (older than the write grace), never a younger neighbour.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import {
  WorkingTreeGraphCache,
  type WorkingTreeGraphBasePool,
} from "../../../../../src/core/api/internal/infra/working-tree-graph-cache.js";
import type { PhysicalCollectionName } from "../../../../../src/core/contracts/types/collection-identity.js";
import type { WorkingTreeGraphRequest } from "../../../../../src/core/contracts/types/working-tree.js";
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
  scratch = mkdtempSync(join(tmpdir(), "wtg-cache-damage-"));
  appRoot = join(scratch, "app", "working-tree");
  baseDbRoot = join(scratch, "base-db");
  mkdirSync(join(baseDbRoot, "codegraph"), { recursive: true });
  writeFileSync(basePath(PHYSICAL), "base-v1");
});

afterEach(() => {
  buildGate.wait = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

function basePath(physical: PhysicalCollectionName): string {
  return join(baseDbRoot, "codegraph", `${physical}.duckdb`);
}

/** A pool that vouches for every collection it is asked about, whether or not the file is there. */
class TrustingPool implements WorkingTreeGraphBasePool {
  isFileReaderOpen(): boolean {
    return false;
  }
  hasDatabase(): boolean {
    return true;
  }
  pathFor(physical: PhysicalCollectionName): string {
    return basePath(physical);
  }
  async exportSnapshot(physical: PhysicalCollectionName, targetPath: string): Promise<void> {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `snapshot of ${physical}`);
  }
}

const buildGate: { wait: Promise<void> | undefined } = { wait: undefined };

const builder = {
  killInFlight(): void {},
  async build(input: WorkingTreeGraphBuildInput): Promise<WorkingTreeGraphBuildOutcome> {
    await buildGate.wait;
    const dbPath = join(input.outputRoot, "codegraph", `${input.physicalCollectionName}.duckdb`);
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, `tree:${input.treeRoot}`);
    return {
      kind: "built",
      graph: { dbPath, durationMs: 1, walkedFileCount: 1, deletedFileCount: 0, hierarchyDependentCount: 0 },
    };
  },
};

function cacheOver(resolveActiveCollection?: () => Promise<PhysicalCollectionName>): WorkingTreeGraphCache {
  return new WorkingTreeGraphCache({
    rootDir: appRoot,
    codegraph: () => ({ pool: new TrustingPool(), providerConfig: PROVIDER_CONFIG }),
    ...(resolveActiveCollection ? { resolveActiveCollection } : {}),
    builder,
    budget: BUDGET,
    now: () => Date.now(),
  });
}

function request(fingerprint = "fp-1", name = "t1"): WorkingTreeGraphRequest {
  const root = join(scratch, "trees", name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), `export const a = "${fingerprint}";`);
  return {
    tree: { root, baseIndex: { collectionName: COLLECTION, root: join(scratch, "base-src") } },
    changed: ["src/a.ts"],
    deleted: [],
    fingerprint,
  };
}

function graphRoot(): string {
  return join(appRoot, COLLECTION, "graph");
}

describe("WorkingTreeGraphCache — a shifting base", () => {
  it("answers unavailable when the pool vouches for a base graph whose file is gone", async () => {
    rmSync(basePath(PHYSICAL));

    const state = await cacheOver(async () => PHYSICAL).graphFor(request(), 10_000);

    expect(state).toMatchObject({ kind: "unavailable" });
    expect((state as { reason: string }).reason).toMatch(/vanished/);
  });

  it("falls back to the physical name derived from the collection when no resolver is wired", async () => {
    const physical = fixturePhysicalCollectionName(COLLECTION);
    writeFileSync(basePath(physical), "base-v1");

    const state = await cacheOver().graphFor(request(), 10_000);

    expect(state).toMatchObject({ kind: "built", physicalCollectionName: physical });
  });
});

describe("WorkingTreeGraphCache#sweep — strays", () => {
  async function sweepAfterBuild(): Promise<{
    result: Awaited<ReturnType<WorkingTreeGraphCache["sweep"]>>;
    trees: string;
    snapshots: string;
  }> {
    const cache = cacheOver(async () => PHYSICAL);
    await cache.graphFor(request(), 10_000);
    const trees = join(graphRoot(), "trees");
    const snapshots = join(graphRoot(), "snapshots");
    const at = Date.now();
    // A file among the key dirs, and key dirs with no readable meta: one past the write grace, one fresh.
    writeFileSync(join(trees, "stray.txt"), "not a key dir");
    const brokenOld = join(trees, "c".repeat(64));
    const brokenFresh = join(trees, "d".repeat(64));
    mkdirSync(brokenOld);
    mkdirSync(brokenFresh);
    const longAgo = new Date(at - 2 * HOUR);
    utimesSync(brokenOld, longAgo, longAgo);
    // A snapshot export cut mid-write: its temp is reclaimed only past the grace.
    const tempOld = join(snapshots, `${PHYSICAL}-0123456789abcdef.duckdb.snapshot-tmp`);
    const tempFresh = join(snapshots, `${PHYSICAL}-fedcba9876543210.duckdb.snapshot-tmp`);
    writeFileSync(tempOld, "half");
    writeFileSync(tempFresh, "half");
    utimesSync(tempOld, longAgo, longAgo);

    const result = await cache.sweep(at);
    return { result, trees, snapshots };
  }

  it("reclaims a metaless key dir and a snapshot temp past the grace, and leaves younger ones and strays alone", async () => {
    const { result, trees, snapshots } = await sweepAfterBuild();

    expect(existsSync(join(trees, "c".repeat(64)))).toBe(false);
    expect(existsSync(join(trees, "d".repeat(64)))).toBe(true);
    expect(existsSync(join(trees, "stray.txt"))).toBe(true);
    expect(readdirSync(snapshots).filter((name) => name.endsWith(".snapshot-tmp"))).toEqual([
      `${PHYSICAL}-fedcba9876543210.duckdb.snapshot-tmp`,
    ]);
    expect(result.evictedGraphs).toBe(1);
    expect(result.evictedStaging).toBe(1);
    expect(result.keptGraphs).toBe(1);
  });
});

describe("WorkingTreeGraphCache — building beside damaged neighbours", () => {
  it("builds a second graph although the trees dir holds a stray file and a key dir whose graph file is gone", async () => {
    const cache = cacheOver(async () => PHYSICAL);
    const first = await cache.graphFor(request("fp-1"), 10_000);
    expect(first.kind).toBe("built");
    const trees = join(graphRoot(), "trees");
    writeFileSync(join(trees, "stray.txt"), "not a key dir");
    rmSync((first as { dbPath: string }).dbPath);

    const second = await cache.graphFor(request("fp-2"), 10_000);

    expect(second).toMatchObject({ kind: "built", physicalCollectionName: PHYSICAL });
    expect(existsSync((second as { dbPath: string }).dbPath)).toBe(true);
  });

  it("builds two trees at once, each published whole while the other is still staging", async () => {
    let release!: () => void;
    buildGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = cacheOver(async () => PHYSICAL);

    const a = cache.graphFor(request("fp-a", "ta"), 10_000);
    const b = cache.graphFor(request("fp-b", "tb"), 10_000);
    release();
    const [stateA, stateB] = await Promise.all([a, b]);

    expect(stateA.kind).toBe("built");
    expect(stateB.kind).toBe("built");
    expect(readdirSync(join(graphRoot(), "trees")).filter((name) => name.includes(".staging-"))).toEqual([]);
  });
});
