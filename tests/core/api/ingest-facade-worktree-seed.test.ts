/**
 * End to end through IngestFacade: a new git worktree's first index is seeded
 * from its already-indexed main checkout (bd tea-rags-mcp-k8gac).
 *
 * The real pipeline, registry, snapshot store, stats cache, indexing lock and
 * footprint saga run against the in-memory Qdrant of the ingest test helpers,
 * extended here with the snapshot/recover calls the Qdrant artifact clones
 * through. The embedding provider tags every vector with the run that produced
 * it, so a point in the worktree's collection is provably COPIED (sibling tag)
 * or EMBEDDED by the worktree's own run (worktree tag).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestFacade } from "../../../src/core/api/index.js";
import { QuarantineStore } from "../../../src/core/domains/ingest/sync/quarantine-store.js";
import { ShardedSnapshotManager } from "../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";
import { CollectionFootprintFactory } from "../../../src/core/domains/maintenance/footprint/factory.js";
import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/collection-registry.js";
import { resolveCollectionName } from "../../../src/core/infra/collection-name.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";
import {
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../domains/ingest/__helpers__/test-helpers.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-bash", () => ({ default: {} }));
vi.mock("tree-sitter-go", () => ({ default: {} }));
vi.mock("tree-sitter-java", () => ({ default: {} }));
vi.mock("tree-sitter-javascript", () => ({ default: {} }));
vi.mock("tree-sitter-python", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({ default: { typescript: {}, tsx: {} } }));

interface StoredPoint {
  id: string | number;
  vector: unknown;
  payload?: Record<string, unknown>;
}

/** The fake's storage, which the snapshot calls below copy wholesale. */
interface MockQdrantStorage {
  points: Map<string, StoredPoint[]>;
  collections: Map<string, unknown>;
}

/**
 * The helpers' in-memory Qdrant plus what a footprint clone needs: a
 * point-in-time snapshot of a collection, recovered under another name, and
 * the alias resolution the clone reads the source's generation through.
 */
class SnapshottingQdrant extends MockQdrantManager {
  readonly isEmbedded = true;
  readonly url = "http://127.0.0.1:6333";
  private readonly snapshots = new Map<string, { points: StoredPoint[]; collection: unknown }>();
  readonly client = {
    scroll: async (collection: string) =>
      Promise.resolve({
        points: this.pointsOf(collection).map((p) => ({ id: p.id, payload: p.payload, vector: p.vector })),
        next_page_offset: null,
      }),
  };

  constructor() {
    super();
    Object.assign(this.aliases, {
      resolveActive: async (name: string) => Promise.resolve(this.aliases.resolve(name)),
    });
  }

  pointsOf(collection: string): StoredPoint[] {
    return this.storage().points.get(this.aliases.resolve(collection)) ?? [];
  }

  async createSnapshot(collection: string): Promise<string> {
    const name = `snap-${this.snapshots.size}`;
    this.snapshots.set(name, {
      points: structuredClone(this.pointsOf(collection)),
      collection: structuredClone(this.storage().collections.get(collection)),
    });
    return Promise.resolve(name);
  }

  snapshotDownloadUrl(_collection: string, snapshotName: string): string {
    return `mock-snapshot://${snapshotName}`;
  }

  async recoverFromSnapshot(target: string, location: string): Promise<void> {
    const snapshot = this.snapshots.get(location.replace("mock-snapshot://", ""));
    if (!snapshot) throw new Error(`no snapshot at ${location}`);
    this.storage().collections.set(target, structuredClone(snapshot.collection));
    this.storage().points.set(target, structuredClone(snapshot.points));
    return Promise.resolve();
  }

  async deleteSnapshot(_collection: string, snapshotName: string): Promise<void> {
    this.snapshots.delete(snapshotName);
    return Promise.resolve();
  }

  private storage(): MockQdrantStorage {
    return this as unknown as MockQdrantStorage;
  }
}

/** Tags every vector with the run that embedded it, and remembers what it embedded. */
class TaggingEmbeddingProvider extends MockEmbeddingProvider {
  tag = 0.1;
  readonly embedded: string[] = [];

  async embedBatch(texts: string[]): Promise<{ embedding: number[]; dimensions: number }[]> {
    this.embedded.push(...texts);
    return Promise.resolve(texts.map(() => ({ embedding: new Array(384).fill(this.tag), dimensions: 384 })));
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

const SIBLING_TAG = 0.1;
const WORKTREE_TAG = 0.2;

/** A function body long enough to chunk, whose `marker` is visible in the chunk text. */
function source(name: string, marker: string): string {
  return [
    `export function ${name}(data: number): number {`,
    `  console.log('${name} processing data with value:', data, '${marker}');`,
    "  const multiplier = 42;",
    "  const result = data * multiplier;",
    `  console.log('${name} computed result:', result);`,
    "  if (result > 100) {",
    `    console.log('${name} result is large');`,
    "  }",
    "  return result;",
    "}",
    "",
  ].join("\n");
}

const FILES: Record<string, string> = {
  "src/unchanged-one.ts": source("unchangedOne", "stable-one"),
  "src/unchanged-two.ts": source("unchangedTwo", "stable-two"),
  "src/modified.ts": source("modified", "before-edit"),
  "src/deleted.ts": source("deleted", "gone-soon"),
};

describe("IngestFacade — first index of a git worktree seeded from its indexed main checkout", () => {
  let root: string;
  let mainCheckout: string;
  let worktree: string;
  let dataDir: string;
  let snapshotDir: string;
  let qdrant: SnapshottingQdrant;
  let embeddings: TaggingEmbeddingProvider;
  let ingest: IngestFacade;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ingest-worktree-seed-")));
    mainCheckout = join(root, "main");
    worktree = join(root, "feature");
    dataDir = join(root, "data");
    snapshotDir = join(dataDir, "snapshots");
    mkdirSync(join(mainCheckout, "src"), { recursive: true });
    for (const [relativePath, content] of Object.entries(FILES)) {
      writeFileSync(join(mainCheckout, relativePath), content);
    }
    git(["init", "-b", "master"], mainCheckout);
    git(["config", "user.email", "test@example.com"], mainCheckout);
    git(["config", "user.name", "Test"], mainCheckout);
    git(["add", "-A"], mainCheckout);
    git(["commit", "-m", "first"], mainCheckout);
    git(["worktree", "add", "-b", "feature", worktree, "HEAD"], mainCheckout);

    qdrant = new SnapshottingQdrant();
    embeddings = new TaggingEmbeddingProvider();
    const registry = new CollectionRegistry(dataDir);
    const statsCache = new StatsCache(snapshotDir);
    ingest = new IngestFacade({
      qdrant: qdrant as never,
      embeddings,
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
      snapshotDir,
      collectionRegistry: registry,
      statsCache,
      allPayloadSignals: [],
      footprintFactory: new CollectionFootprintFactory({
        qdrant: qdrant as never,
        pool: { cloneDatabase: vi.fn(), removeCollection: vi.fn(), listCollectionDbNames: vi.fn(() => []) },
        statsCache,
        snapshotBaseDir: snapshotDir,
        snapshotStoreFactory: (baseDir, logicalName) => new ShardedSnapshotManager(baseDir, logicalName),
        quarantineStoreFactory: (baseDir, logicalName) => new QuarantineStore(baseDir, logicalName),
        indexingLockStoreFactory: () => ({ removeIfStale: async () => Promise.resolve({ status: "absent" as const }) }),
      }),
    });

    // The sibling: an ordinary first index of the main checkout, settled.
    embeddings.tag = SIBLING_TAG;
    const siblingStats = await ingest.indexCodebase(mainCheckout);
    expect(siblingStats.worktreeSeed).toMatchObject({ status: "skipped", reason: "no-sibling" });
    await ingest.whenEnrichmentComplete();
    embeddings.tag = WORKTREE_TAG;
    embeddings.embedded.length = 0;

    // The worktree diverges: one file edited, one added, one removed.
    writeFileSync(join(worktree, "src/modified.ts"), source("modified", "after-edit"));
    writeFileSync(join(worktree, "src/added.ts"), source("added", "brand-new"));
    unlinkSync(join(worktree, "src/deleted.ts"));
  }, 120_000);

  afterEach(async () => {
    await ingest.whenEnrichmentComplete();
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  const byPath = (points: StoredPoint[], relativePath: string): StoredPoint[] =>
    points
      .filter((p) => p.payload?.relativePath === relativePath)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  it("copies the sibling's points for byte-identical files and embeds only what differs", async () => {
    const siblingCollection = resolveCollectionName(mainCheckout);
    const siblingBefore = structuredClone(qdrant.pointsOf(siblingCollection));

    const stats = await ingest.indexCodebase(worktree);

    expect(stats.worktreeSeed).toEqual({
      status: "seeded",
      source: { collectionName: siblingCollection, project: null, path: mainCheckout },
      filesCopied: 2,
      filesIndexed: 2,
      filesRemoved: 1,
      gitRefresh: "not-applicable",
      rejected: [],
    });

    const sibling = qdrant.pointsOf(siblingCollection);
    const seeded = qdrant.pointsOf(resolveCollectionName(worktree));
    for (const unchanged of ["src/unchanged-one.ts", "src/unchanged-two.ts"]) {
      const copied = byPath(seeded, unchanged);
      expect(copied.length).toBeGreaterThan(0);
      // Same ids, same vectors (the SIBLING's tag), same payload — copied, not re-embedded.
      expect(copied).toEqual(byPath(sibling, unchanged));
      for (const point of copied) expect((point.vector as number[])[0]).toBe(SIBLING_TAG);
    }

    for (const changed of ["src/modified.ts", "src/added.ts"]) {
      const embedded = byPath(seeded, changed);
      expect(embedded.length).toBeGreaterThan(0);
      for (const point of embedded) expect((point.vector as number[])[0]).toBe(WORKTREE_TAG);
    }
    expect(JSON.stringify(byPath(seeded, "src/modified.ts").map((p) => p.payload?.content))).toContain("after-edit");
    expect(byPath(seeded, "src/deleted.ts")).toEqual([]);

    // The embedding provider saw the two differing files and nothing else.
    expect(embeddings.embedded.some((text) => text.includes("after-edit"))).toBe(true);
    expect(embeddings.embedded.some((text) => text.includes("brand-new"))).toBe(true);
    expect(embeddings.embedded.some((text) => text.includes("stable-one") || text.includes("stable-two"))).toBe(false);

    // The sibling's own collection is exactly as it was.
    expect(qdrant.pointsOf(siblingCollection)).toEqual(siblingBefore);

    // And the seeded collection is an ordinary one from here on: the next run
    // is a no-change incremental, not a second seed.
    await ingest.whenEnrichmentComplete();
    const again = await ingest.indexCodebase(worktree);
    expect(again.worktreeSeed).toBeUndefined();
    expect(again.changeDetails).toMatchObject({ filesAdded: 0, filesModified: 0, filesDeleted: 0 });
  }, 120_000);

  it("indexes the worktree from scratch when the caller opts out", async () => {
    const stats = await ingest.indexCodebase(worktree, { seedFromWorktree: false });

    expect(stats.worktreeSeed).toEqual({ status: "skipped", reason: "disabled", rejected: [] });
    const seeded = qdrant.pointsOf(resolveCollectionName(worktree));
    const chunks = seeded.filter((p) => p.payload?.relativePath);
    expect(chunks.length).toBeGreaterThan(0);
    for (const point of chunks) expect((point.vector as number[])[0]).toBe(WORKTREE_TAG);
    expect(embeddings.embedded.some((text) => text.includes("stable-one"))).toBe(true);
  }, 120_000);
});
