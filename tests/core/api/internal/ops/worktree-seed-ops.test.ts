/**
 * WorktreeSeedOps — picks the sibling that seeds a new worktree's first index
 * and clones its footprint, or says why none did (bd tea-rags-mcp-k8gac).
 *
 * The stamp gate itself is pinned in `worktree-seed-source.test.ts`; this file
 * pins the LIVE rules around it: the sibling must be claimed for the clone's
 * whole duration, must hold a completed index with a snapshot, must pass the
 * weights canary, and a refused sibling hands over to the next one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureCollectionAlias } from "../../../__helpers__/collection-identity.js";
import { EMBEDDED_MARKER } from "../../../../../src/core/adapters/qdrant/embedded/daemon.js";
import { WorktreeSeedOps } from "../../../../../src/core/api/internal/ops/worktree-seed-ops.js";
import { INDEXING_METADATA_ID } from "../../../../../src/core/contracts/constants.js";
import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";
import type { WorktreeSeedPending } from "../../../../../src/core/domains/ingest/pipeline/indexing-marker-codec.js";
import { ShardedSnapshotManager } from "../../../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";
import type { CollectionFootprintFactory } from "../../../../../src/core/domains/maintenance/footprint/index.js";
import { QdrantArtifact } from "../../../../../src/core/domains/maintenance/footprint/qdrant-artifact.js";
import type { WorktreeSeedBuildIdentity } from "../../../../../src/core/domains/maintenance/worktree/worktree-seed-source.js";

const TEST_TIMEOUT = 60000;
const PAYLOAD_KEYS = ["relativePath", "navigation"];

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function entry(collectionName: string, path: string, indexedAt: string, over: Partial<CollectionEntry> = {}) {
  return {
    collectionName,
    path,
    name: collectionName.replace("code_", ""),
    embeddingModel: "nomic",
    embeddingDimensions: 768,
    qdrantUrl: EMBEDDED_MARKER,
    qdrantEmbedded: true,
    codegraphEnabled: false,
    env: { INGEST_CHUNK_SIZE: "2500" },
    indexedAt,
    teaRagsVersion: "1.42.0",
    chunksCount: 3,
    ...over,
  } satisfies CollectionEntry;
}

const BUILD: WorktreeSeedBuildIdentity = {
  payloadFieldKeys: PAYLOAD_KEYS,
  envSnapshot: { INGEST_CHUNK_SIZE: "2500" },
  embeddingModel: "nomic",
  codegraphEnabled: false,
  qdrant: { embedded: true, url: "http://127.0.0.1:6333" },
};

/** What the seeded collection will owe until its stamp and git rebuild are done. */
const PENDING: WorktreeSeedPending = {
  seededAt: "2026-09-19T00:00:00Z",
  languageVersions: { typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 } },
};

const never = async (): Promise<never> => new Promise<never>(() => undefined);

/**
 * A Qdrant that remembers what a clone leaves behind: collections by physical
 * name (each with its marker point's payload) and aliases. The source's marker
 * is copied by the snapshot recover, exactly like the real one.
 */
function cloneTrackingQdrant(options: { markerWriteFails?: boolean } = {}) {
  const markers = new Map<string, Record<string, unknown>>();
  const aliases = new Map<string, string>();
  const calls: string[] = [];
  const qdrant = {
    createSnapshot: vi.fn(async () => Promise.resolve("snap-1")),
    snapshotDownloadUrl: vi.fn(() => "http://127.0.0.1:6333/snap-1"),
    recoverFromSnapshot: vi.fn(async (name: string) => {
      calls.push(`recover:${name}`);
      markers.set(name, { indexingComplete: true, completedAt: "2026-09-10T00:00:00Z" });
      return Promise.resolve();
    }),
    setPayload: vi.fn(
      async (name: string, payload: Record<string, unknown>, opts: { points?: (string | number)[] }) => {
        calls.push(`setPayload:${name}`);
        if (options.markerWriteFails) throw new Error("marker write refused");
        if (opts.points?.includes(INDEXING_METADATA_ID)) markers.set(name, { ...markers.get(name), ...payload });
        return Promise.resolve();
      },
    ),
    deleteSnapshot: vi.fn(async () => Promise.resolve()),
    deleteCollection: vi.fn(async (name: string) => {
      markers.delete(name);
      return Promise.resolve();
    }),
    aliases: {
      createAlias: vi.fn(async (alias: string, name: string) => {
        calls.push(`alias:${alias}`);
        aliases.set(alias, name);
        return Promise.resolve();
      }),
      deleteAlias: vi.fn(async (alias: string) => {
        aliases.delete(alias);
        return Promise.resolve();
      }),
    },
  };
  return { qdrant, markers, aliases, calls };
}

/** The real saga order's first step, the real Qdrant clone, then an artifact whose clone never returns (the kill). */
function killedAfterQdrantClone(qdrant: unknown): Pick<CollectionFootprintFactory, "build"> {
  return {
    build: (source, target) => ({
      context: { source, target },
      artifacts: [
        new QdrantArtifact(qdrant as never),
        { id: "codegraph", addressing: "physical", clone: never, remove: async () => Promise.resolve() },
      ],
    }),
  };
}

describe("WorktreeSeedOps", () => {
  let root: string;
  let mainCheckout: string;
  let otherWorktree: string;
  let newWorktree: string;
  let snapshotDir: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-seed-ops-")));
    mainCheckout = join(root, "main");
    otherWorktree = join(root, "other");
    newWorktree = join(root, "new");
    snapshotDir = join(root, "snapshots");
    mkdirSync(mainCheckout, { recursive: true });
    git(["init", "-b", "master"], mainCheckout);
    git(["config", "user.email", "test@example.com"], mainCheckout);
    git(["config", "user.name", "Test"], mainCheckout);
    writeFileSync(join(mainCheckout, "a.ts"), "export const a = 1;\n");
    git(["add", "-A"], mainCheckout);
    git(["commit", "-m", "first"], mainCheckout);
    git(["worktree", "add", "--detach", otherWorktree, "HEAD"], mainCheckout);
    git(["worktree", "add", "--detach", newWorktree, "HEAD"], mainCheckout);

    for (const [collection, files] of [
      ["code_main", 3],
      ["code_other", 2],
    ] as const) {
      const snapshot = new ShardedSnapshotManager(snapshotDir, collection);
      const entries = new Map(
        Array.from({ length: files }, (_, i) => [`f${i}.ts`, { hash: `h${i}`, mtime: 1, size: 1 }] as const),
      );
      await snapshot.save(join(root, collection), entries);
    }
  }, TEST_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  let entries: CollectionEntry[];
  let indexed: Set<string>;
  let releases: string[];
  let claims: string[];
  let busy: Set<string>;
  let builds: { source: Record<string, unknown>; target: Record<string, unknown> }[];
  let cloneFails: boolean;
  let modelGuard: { ensureMatch: ReturnType<typeof vi.fn> };

  function ops(footprintFactory?: Pick<CollectionFootprintFactory, "build">) {
    return new WorktreeSeedOps({
      registry: { list: () => entries },
      qdrant: {
        collectionExists: vi.fn(async (name: string) => indexed.has(name)),
        getPoint: vi.fn(async (name: string, id: string | number) =>
          id === INDEXING_METADATA_ID && indexed.has(name)
            ? { id, payload: { indexingComplete: name !== "code_half" } }
            : null,
        ),
        aliases: { resolveActive: vi.fn(async (name: string) => `${name}_v3`) },
      } as never,
      statsCache: {
        load: vi.fn(() => ({ payloadFieldKeys: PAYLOAD_KEYS, distributions: { language: { typescript: 3 } } })),
      } as never,
      footprintFactory:
        footprintFactory ??
        ({
          build: vi.fn((source: Record<string, unknown>, target: Record<string, unknown>) => {
            builds.push({ source, target });
            return {
              context: { source, target },
              artifacts: [
                {
                  id: "qdrant",
                  addressing: "physical",
                  clone: async () => {
                    if (cloneFails) throw new Error("snapshot recover refused");
                  },
                  remove: async () => undefined,
                },
              ],
            };
          }),
        } as never),
      snapshotDir,
      modelGuard: modelGuard as never,
    });
  }

  function request() {
    return {
      targetPath: newWorktree,
      targetCollection: fixtureCollectionAlias("code_new"),
      build: BUILD,
      pending: PENDING,
      claimSource: vi.fn(async (name: string) => {
        claims.push(name);
        if (busy.has(name)) return undefined;
        return async () => {
          releases.push(name);
        };
      }),
    };
  }

  beforeEach(() => {
    entries = [
      entry("code_main", mainCheckout, "2026-09-10T00:00:00Z"),
      entry("code_other", otherWorktree, "2026-09-01T00:00:00Z"),
    ];
    indexed = new Set(["code_main", "code_other"]);
    releases = [];
    claims = [];
    busy = new Set();
    builds = [];
    cloneFails = false;
    modelGuard = { ensureMatch: vi.fn(async () => undefined) };
  });

  it("clones the newest compatible sibling onto the target's first generation, under the sibling's claim", async () => {
    const attempt = await ops().seed(request());

    expect(attempt).toMatchObject({
      status: "seeded",
      source: { collectionName: "code_main", project: "main", path: mainCheckout },
      sourceFiles: 3,
      rejected: [],
    });
    expect(builds).toHaveLength(1);
    expect(builds[0].source).toMatchObject({ logicalName: "code_main", physicalName: "code_main_v3" });
    expect(builds[0].target).toMatchObject({
      logicalName: "code_new",
      physicalName: "code_new_v1",
      path: newWorktree,
    });
    expect(claims).toEqual(["code_main"]);
    expect(releases).toEqual(["code_main"]);
  });

  it("skips with no-sibling when no other working tree of the repository is registered", async () => {
    entries = [];
    const attempt = await ops().seed(request());
    expect(attempt).toEqual({ status: "skipped", reason: "no-sibling", rejected: [] });
    expect(builds).toHaveLength(0);
  });

  it("refuses a sibling another run holds and falls through to the next one", async () => {
    busy.add("code_main");
    const attempt = await ops().seed(request());

    expect(attempt).toMatchObject({
      status: "seeded",
      source: { collectionName: "code_other" },
      sourceFiles: 2,
      rejected: [{ collectionName: "code_main", reason: "source-busy" }],
    });
    // The refused claim was never taken, so there is nothing of it to release.
    expect(releases).toEqual(["code_other"]);
  });

  it("refuses a sibling whose last index never completed", async () => {
    entries = [entry("code_half", mainCheckout, "2026-09-10T00:00:00Z")];
    indexed.add("code_half");
    const attempt = await ops().seed(request());

    expect(attempt).toMatchObject({
      status: "skipped",
      reason: "no-compatible-sibling",
      rejected: [{ collectionName: "code_half", reason: "source-not-indexed" }],
    });
    expect(releases).toEqual(["code_half"]);
    expect(builds).toHaveLength(0);
  });

  it("refuses a registered sibling with no collection behind it", async () => {
    indexed.delete("code_main");
    const attempt = await ops().seed(request());
    expect(attempt).toMatchObject({
      status: "seeded",
      source: { collectionName: "code_other" },
      rejected: [{ collectionName: "code_main", reason: "source-not-indexed" }],
    });
  });

  it("refuses a sibling with no file snapshot — the incremental sync would have nothing to diff against", async () => {
    entries = [entry("code_nosnap", mainCheckout, "2026-09-10T00:00:00Z")];
    indexed.add("code_nosnap");
    const attempt = await ops().seed(request());
    expect(attempt).toMatchObject({
      status: "skipped",
      rejected: [{ collectionName: "code_nosnap", reason: "source-not-indexed" }],
    });
    expect(builds).toHaveLength(0);
  });

  it("refuses a sibling whose vectors fail this run's weights canary", async () => {
    modelGuard = {
      ensureMatch: vi.fn(async (name: string) => {
        if (name === "code_main") throw new Error("canary cosine 0.41 below threshold");
      }),
    };
    const attempt = await ops().seed(request());
    expect(attempt).toMatchObject({
      status: "seeded",
      source: { collectionName: "code_other" },
      rejected: [{ collectionName: "code_main", reason: "embedding-model", detail: expect.stringContaining("0.41") }],
    });
  });

  it("refuses a sibling on a stamp mismatch before claiming it", async () => {
    entries = [entry("code_main", mainCheckout, "2026-09-10T00:00:00Z", { embeddingModel: "jina" })];
    const attempt = await ops().seed(request());
    expect(attempt).toMatchObject({
      status: "skipped",
      reason: "no-compatible-sibling",
      rejected: [{ collectionName: "code_main", reason: "embedding-model" }],
    });
    expect(claims).toEqual([]);
  });

  it("reports a failed clone and still lets go of the sibling", async () => {
    cloneFails = true;
    const attempt = await ops().seed(request());
    expect(attempt).toMatchObject({
      status: "skipped",
      reason: "no-compatible-sibling",
      rejected: [
        { collectionName: "code_main", reason: "clone-failed", detail: expect.stringContaining("recover refused") },
        { collectionName: "code_other", reason: "clone-failed" },
      ],
    });
    expect(releases).toEqual(["code_main", "code_other"]);
  });

  /**
   * bd tea-rags-mcp-k8gac, residual window: the pending seed used to be written
   * only after the whole saga returned, so a process killed anywhere between
   * the alias creation and that write left a VISIBLE clone with no marker — the
   * unstamped clone with the sibling's git signals that the marker exists to
   * prevent. It now rides the Qdrant clone, before the alias.
   */
  it("a process killed after the Qdrant clone leaves a visible clone that already records the pending seed", async () => {
    const tracked = cloneTrackingQdrant();

    void ops(killedAfterQdrantClone(tracked.qdrant)).seed(request());
    await vi.waitFor(() => {
      expect(tracked.aliases.get("code_new")).toBe("code_new_v1");
    });

    expect(tracked.calls).toEqual(["recover:code_new_v1", "setPayload:code_new_v1", "alias:code_new"]);
    expect(tracked.markers.get("code_new_v1")).toMatchObject({ indexingComplete: true, worktreeSeedPending: PENDING });
  });

  it("a pending seed that cannot be recorded rolls the clone back — nothing is exposed, the sibling is refused", async () => {
    const tracked = cloneTrackingQdrant({ markerWriteFails: true });
    entries = [entry("code_main", mainCheckout, "2026-09-10T00:00:00Z")];

    const attempt = await ops({
      build: (source, target) => ({
        context: { source, target },
        artifacts: [new QdrantArtifact(tracked.qdrant as never)],
      }),
    }).seed(request());

    expect(attempt).toMatchObject({
      status: "skipped",
      rejected: [{ collectionName: "code_main", reason: "clone-failed", detail: "marker write refused" }],
    });
    expect(tracked.aliases.size).toBe(0);
    expect(tracked.markers.has("code_new_v1")).toBe(false);
    expect(releases).toEqual(["code_main"]);
  });
});
