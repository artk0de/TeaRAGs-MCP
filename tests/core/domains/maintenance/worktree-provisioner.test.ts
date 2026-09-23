import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CollectionIndexingLock } from "../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import {
  WorktreeCollectionExistsError,
  WorktreeNotFoundError,
  WorktreeSourceNotFoundError,
} from "../../../../src/core/domains/maintenance/errors.js";
import { CollectionFootprintFactory } from "../../../../src/core/domains/maintenance/footprint/factory.js";
import { WorktreeProvisioner } from "../../../../src/core/domains/maintenance/worktree/worktree-provisioner.js";
import { resolveCollectionName } from "../../../../src/core/infra/collection-name.js";

function fakeArtifact(id: string, calls: string[], failOn?: string) {
  return {
    id,
    clone: vi.fn(async () => {
      calls.push(`clone:${id}`);
      if (failOn === id) throw new Error(`boom ${id}`);
    }),
    remove: vi.fn(async () => {
      calls.push(`remove:${id}`);
    }),
  };
}

function makeDeps(over: Partial<Record<string, unknown>> = {}, calls: string[] = [], failOn?: string) {
  const sourceEntry = {
    collectionName: "code_src",
    path: "/repo",
    name: "proj",
    embeddingModel: "j",
    embeddingDimensions: 768,
    qdrantUrl: "http://h",
    qdrantEmbedded: true,
    embeddingBaseUrl: "http://192.168.1.71:11434",
    embeddingFallbackUrl: "http://localhost:11434",
    codegraphEnabled: true,
    tuning: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5" },
    languageVersions: { ruby: { walker: 4, codegraphSchema: 2 } } as Record<string, Record<string, number>> | undefined,
    indexedAt: "t",
    teaRagsVersion: "1",
    chunksCount: 5,
  };
  const recorded: Record<string, unknown>[] = [];
  // Track what footprintFactory.build() was called with for assertion
  const buildCalls: { source: unknown; target: unknown }[] = [];
  return {
    calls,
    recorded,
    buildCalls,
    sourceEntry,
    deps: {
      registry: {
        findByName: vi.fn(() => sourceEntry),
        // Path-aware on purpose: `create` asks findByPath twice — once for the
        // source (cwd, when no `from`), once to check the TARGET path is free.
        findByPath: vi.fn((p: string) => (p === process.cwd() ? sourceEntry : null)),
        get: vi.fn(() => null),
        record: vi.fn((e: Record<string, unknown>) => recorded.push(e)),
        setName: vi.fn(),
        setWorktreeProvenance: vi.fn(),
        stampLanguageVersions: vi.fn(),
        remove: vi.fn(() => true),
        listWorktrees: vi.fn(() => []),
        findWorktree: vi.fn(() => null),
      },
      qdrant: {
        aliases: { resolveActive: vi.fn(async () => "code_src_v1") },
        listCollections: vi.fn(async () => []),
      },
      footprintFactory: {
        build: vi.fn((source: unknown, target: unknown) => {
          buildCalls.push({ source, target });
          return {
            context: { source: {}, target: { logicalName: "code_dst" } },
            artifacts: ["qdrant", "codegraph", "snapshot", "stats", "quarantine"].map((id) =>
              fakeArtifact(id, calls, failOn),
            ),
          };
        }),
      },
      dataDir: "/data",
      ...over,
    } as never,
  };
}

describe("WorktreeProvisioner.create saga", () => {
  it("clones all artifacts then commits the registry entry with provenance", async () => {
    const { deps, calls, recorded } = makeDeps();
    const ops = new WorktreeProvisioner(deps);
    const res = await ops.create({ name: "x", createGit: false });
    expect(calls).toEqual(["clone:qdrant", "clone:codegraph", "clone:snapshot", "clone:stats", "clone:quarantine"]);
    expect(recorded).toHaveLength(1);
    expect(deps.registry.setWorktreeProvenance).toHaveBeenCalled();
    expect(res.alias).toContain("worktree-x");
  });

  it("propagates qdrantEmbedded from the source entry to the worktree clone entry", async () => {
    // The clone points at the same Qdrant backend as its source, so an embedded
    // source yields an embedded clone — otherwise a bare-shell reindex of the
    // worktree would pin the source's frozen port instead of re-resolving.
    const { deps, recorded } = makeDeps();
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect(recorded[0].qdrantEmbedded).toBe(true);
  });

  it("propagates the env snapshot from the source entry to the worktree clone entry", async () => {
    // A worktree reindex runs in a fresh shell; the clone entry must carry the
    // source project's index-time env set so the registry-first re-apply keeps
    // the same knobs (mirrors qdrantEmbedded / codegraphEnabled propagation).
    // Legacy sources store it in the deprecated `tuning` field — the clone
    // normalizes it into `env`.
    const { deps, recorded } = makeDeps();
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect(recorded[0].env).toEqual({ TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5" });
  });

  it("propagates the embedding endpoints from the source entry to the worktree clone entry", async () => {
    // A clone indexes the SAME code against the SAME embedding backend, so it
    // must inherit the endpoints its source was indexed against. Dropping them
    // sends a worktree reindex to the built-in default (localhost:11434): on a
    // remote-Ollama setup that host is dead, so the run burns two 240s recovery
    // budgets and dies before enrichment — no repair pass, no recovery, and a
    // graph left exactly as stale as the clone found it.
    const { deps, recorded } = makeDeps();
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect(recorded[0].embeddingBaseUrl).toBe("http://192.168.1.71:11434");
    expect(recorded[0].embeddingFallbackUrl).toBe("http://localhost:11434");
  });

  it("omits the embedding endpoints on the clone when the source entry has none", async () => {
    // Symmetric with the env-snapshot legacy case: absent stays absent rather
    // than becoming an explicit undefined the registry would serialize.
    const { deps, recorded, sourceEntry } = makeDeps();
    const { embeddingBaseUrl: _b, embeddingFallbackUrl: _f, ...legacy } = sourceEntry;
    deps.registry.findByName = vi.fn(() => legacy);
    deps.registry.findByPath = vi.fn((p: string) => (p === process.cwd() ? legacy : null));
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect("embeddingBaseUrl" in recorded[0]).toBe(false);
    expect("embeddingFallbackUrl" in recorded[0]).toBe(false);
  });

  it("omits the env snapshot on the clone when the source entry has none (legacy entry)", async () => {
    const { deps, recorded, sourceEntry } = makeDeps();
    const { tuning: _tuning, env: _env, ...legacy } = sourceEntry;
    deps.registry.findByName = vi.fn(() => legacy);
    deps.registry.findByPath = vi.fn((p: string) => (p === process.cwd() ? legacy : null));
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect("env" in recorded[0]).toBe(false);
    expect("tuning" in recorded[0]).toBe(false);
  });

  it("carries the source entry's language-version stamp onto the worktree clone", async () => {
    // A clone holds the source's points verbatim, so it is as current as the
    // source. Leaving the stamp off makes every language read as version 1 and
    // the drift monitor demands a --force rebuild of already-current data.
    const { deps, recorded } = makeDeps();
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect(deps.registry.stampLanguageVersions).toHaveBeenCalledWith(recorded[0].collectionName, {
      ruby: { walker: 4, codegraphSchema: 2 },
    });
  });

  it("does not stamp language versions when the source entry has none (legacy source)", async () => {
    const { deps, sourceEntry } = makeDeps();
    delete (sourceEntry as { languageVersions?: unknown }).languageVersions;
    const ops = new WorktreeProvisioner(deps);
    await ops.create({ name: "x", createGit: false });
    expect(deps.registry.stampLanguageVersions).not.toHaveBeenCalled();
  });

  it("rolls back ALL artifacts including the failing one in reverse on failure", async () => {
    // C2: the failing artifact (snapshot) must participate in rollback
    const { deps, calls, recorded } = makeDeps({}, [], "snapshot");
    const ops = new WorktreeProvisioner(deps);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/boom snapshot/);
    expect(calls).toEqual([
      "clone:qdrant",
      "clone:codegraph",
      "clone:snapshot",
      "remove:snapshot", // failing artifact participates in rollback
      "remove:codegraph",
      "remove:qdrant",
    ]);
    expect(recorded).toHaveLength(0);
  });

  it("throws WorktreeCollectionExistsError if the target path is already provisioned, before any clone", async () => {
    // I1: typed error for target-exists guard. Asked BY PATH (bd tea-rags-mcp-dxa9w):
    // the entry that claims a directory is the one that says it is taken, and a
    // relocated entry's collection is not what its path hashes to.
    const calls: string[] = [];
    const { deps, sourceEntry } = makeDeps({}, calls);
    deps.registry.findByPath = vi.fn((p: string) =>
      p === process.cwd() ? sourceEntry : { ...sourceEntry, collectionName: "code_dst" },
    );
    const ops = new WorktreeProvisioner(deps);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(WorktreeCollectionExistsError);
    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/already exists/);
    expect(calls).toEqual([]);
  });

  it("throws WorktreeCollectionExistsError when the target NAME belongs to a relocated project", async () => {
    // The case `findByPath` cannot see (bd tea-rags-mcp-dxa9w): an entry whose
    // collectionName IS what this directory hashes to, but whose path has since
    // moved away — exactly what `register` leaves behind when a project
    // relocates. The directory reads as free, and without the second guard the
    // saga would clone into that live project's collection, overwrite its
    // registry entry, take its alias, and stamp it `worktreeOf` — after which
    // `worktree remove` deletes a real project.
    const calls: string[] = [];
    const { deps, sourceEntry } = makeDeps({}, calls);
    const targetLogical = resolveCollectionName(join(process.cwd(), "x"));
    deps.registry.findByPath = vi.fn((p: string) => (p === process.cwd() ? sourceEntry : null));
    deps.registry.get = vi.fn((name: string) =>
      name === targetLogical ? { ...sourceEntry, collectionName: targetLogical, path: "/moved/elsewhere" } : null,
    );
    const ops = new WorktreeProvisioner(deps);

    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(WorktreeCollectionExistsError);
    expect(calls).toEqual([]);
    expect(deps.registry.record).not.toHaveBeenCalled();
  });

  it("throws WorktreeSourceNotFoundError when source project is not found", async () => {
    // I1: typed error for source-not-found guard
    const { deps } = makeDeps();
    deps.registry.findByName = vi.fn(() => null);
    deps.registry.findByPath = vi.fn(() => null);
    const ops = new WorktreeProvisioner(deps);
    await expect(ops.create({ name: "x", from: "missing", createGit: false })).rejects.toThrow(
      WorktreeSourceNotFoundError,
    );
    await expect(ops.create({ name: "x", from: "missing", createGit: false })).rejects.toThrow(
      /Source project not found/,
    );
  });
});

describe("WorktreeProvisioner.create with git (C1)", () => {
  it("calls injected removeGitWorktree when gitCreated=true and artifact clone fails", async () => {
    const calls: string[] = [];
    const removeGitWorktree = vi.fn();
    const ensureGitWorktree = vi.fn(() => true); // returns true = worktree was created

    const { deps } = makeDeps({}, calls, "qdrant");
    const ops = new WorktreeProvisioner({
      ...deps,
      ensureGitWorktree,
      removeGitWorktree,
    } as never);

    await expect(ops.create({ name: "x", createGit: true })).rejects.toThrow(/boom qdrant/);
    expect(ensureGitWorktree).toHaveBeenCalled();
    // worktree was created → must be rolled back
    expect(removeGitWorktree).toHaveBeenCalledWith("/repo", expect.any(String), true);
  });

  it("does NOT call removeGitWorktree when gitCreated=false (attach path) and artifact fails", async () => {
    const calls: string[] = [];
    const removeGitWorktree = vi.fn();
    const ensureGitWorktree = vi.fn(() => false); // returns false = attached to existing dir

    const { deps } = makeDeps({}, calls, "qdrant");
    const ops = new WorktreeProvisioner({
      ...deps,
      ensureGitWorktree,
      removeGitWorktree,
    } as never);

    await expect(ops.create({ name: "x", createGit: true })).rejects.toThrow(/boom qdrant/);
    expect(ensureGitWorktree).toHaveBeenCalled();
    // was not created (attached) → must NOT be removed
    expect(removeGitWorktree).not.toHaveBeenCalled();
  });

  it("does NOT call removeGitWorktree when createGit=false and artifact fails", async () => {
    const calls: string[] = [];
    const removeGitWorktree = vi.fn();
    const ensureGitWorktree = vi.fn(() => false);

    const { deps } = makeDeps({}, calls, "qdrant");
    const ops = new WorktreeProvisioner({
      ...deps,
      ensureGitWorktree,
      removeGitWorktree,
    } as never);

    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow(/boom qdrant/);
    expect(ensureGitWorktree).not.toHaveBeenCalled();
    expect(removeGitWorktree).not.toHaveBeenCalled();
  });
});

describe("WorktreeProvisioner.remove guard", () => {
  it("throws WorktreeNotFoundError when entry has no worktree provenance", async () => {
    // I1: typed error for remove guard
    const { deps } = makeDeps({
      registry: { findWorktree: vi.fn(() => null) },
    });
    const ops = new WorktreeProvisioner(deps);
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true })).rejects.toThrow(
      WorktreeNotFoundError,
    );
    await expect(ops.remove({ name: "real-project", force: false, keepGit: true })).rejects.toThrow(/not a worktree/i);
  });
});

describe("WorktreeProvisioner.remove with git cleanup", () => {
  it("calls removeGitWorktree when keepGit is false and source repo root is known", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const sourceEntry = {
      collectionName: "code_src",
      path: "/repo",
      name: "proj",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
    };
    const removeGitWorktree = vi.fn();
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => sourceEntry);
    deps.qdrant.aliases.resolveActive = vi.fn(async () => "code_src_v1");

    const ops = new WorktreeProvisioner({ ...deps, removeGitWorktree } as never);
    const result = await ops.remove({ name: "feat", force: false, keepGit: false });

    expect(result.removed).toBe(true);
    expect(removeGitWorktree).toHaveBeenCalledWith("/repo", "/wt", false);
  });

  it("does NOT call removeGitWorktree when keepGit is true", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const removeGitWorktree = vi.fn();
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => ({ path: "/repo" }));
    deps.qdrant.aliases.resolveActive = vi.fn(async () => "code_src_v1");

    const ops = new WorktreeProvisioner({ ...deps, removeGitWorktree } as never);
    await ops.remove({ name: "feat", force: true, keepGit: true });

    expect(removeGitWorktree).not.toHaveBeenCalled();
  });

  it("does NOT call removeGitWorktree when source repo root is not found in registry", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const removeGitWorktree = vi.fn();
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => null); // source not found
    deps.qdrant.aliases.resolveActive = vi.fn(async () => "code_src_v1");

    const ops = new WorktreeProvisioner({ ...deps, removeGitWorktree } as never);
    await ops.remove({ name: "feat", force: false, keepGit: false });

    expect(removeGitWorktree).not.toHaveBeenCalled();
  });
});

describe("WorktreeProvisioner.remove indexing lock", () => {
  const DEAD_PID = 4242;
  const LIVE_PID = 5151;
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The real artifact saga over fakes, except the indexing lock: a real file under real rules. */
  function footprintWithRealLock(snapshotBaseDir: string) {
    const qdrant = {
      aliases: { deleteAlias: vi.fn(async () => undefined) },
      deleteCollection: vi.fn(async () => undefined),
    };
    const footprintFactory = new CollectionFootprintFactory({
      qdrant: qdrant as never,
      pool: {
        cloneDatabase: vi.fn(async () => undefined),
        removeCollection: vi.fn(async () => true),
        listCollectionDbNames: vi.fn(() => []),
      },
      statsCache: { clone: vi.fn(), invalidate: vi.fn() } as never,
      snapshotBaseDir,
      snapshotStoreFactory: () => ({ cloneTo: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) }),
      quarantineStoreFactory: () => ({
        cloneTo: vi.fn(async () => undefined),
        clearAll: vi.fn(async () => undefined),
      }),
      indexingLockStoreFactory: (baseDir, logicalName) => ({
        removeIfStale: async () =>
          new CollectionIndexingLock({ lockDir: baseDir, isProcessAlive: (pid) => pid !== DEAD_PID }).removeIfStale(
            logicalName,
          ),
      }),
    });
    return { footprintFactory, qdrant };
  }

  it.each([
    ["removes the lock a dead run left", DEAD_PID, false],
    ["leaves a live run's lock in place", LIVE_PID, true],
  ])("tears the clone down and %s", async (_label, pid, lockSurvives) => {
    dir = mkdtempSync(join(tmpdir(), "wt-lock-"));
    const lockFile = join(dir, "code_dst.indexing.lock");
    const now = new Date().toISOString();
    writeFileSync(
      lockFile,
      JSON.stringify({ pid, hostname: hostname(), startedAt: now, heartbeatAt: now, operation: "index-codebase" }),
    );
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.qdrant.aliases.resolveActive = vi.fn(async (name: string) => `${name}_v1`);
    const { footprintFactory, qdrant } = footprintWithRealLock(dir);

    const ops = new WorktreeProvisioner({ ...(deps as object), footprintFactory } as never);
    const result = await ops.remove({ name: "feat", force: false, keepGit: true });

    expect(result.removed).toBe(true);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_dst_v1");
    expect(deps.registry.remove).toHaveBeenCalledWith("code_dst");
    expect(existsSync(lockFile)).toBe(lockSurvives);
  });
});

describe("WorktreeProvisioner.remove physical resolution", () => {
  it("uses resolveActive result as target physicalName, not hardcoded _v1", async () => {
    // Bug 2: after a reindex the active physical may be _v2+; remove must NOT hardcode _v1
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: true,
    };
    const { deps, buildCalls } = makeDeps();
    // Stub findWorktree to return a worktree entry
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    // resolveActive returns _v2 for the TARGET collection (simulating post-reindex state)
    deps.qdrant.aliases.resolveActive = vi.fn(async (name: string) => {
      if (name === "code_src") return "code_src_v1";
      if (name === "code_dst") return "code_dst_v2";
      return `${name}_v1`;
    });

    const ops = new WorktreeProvisioner(deps);
    await ops.remove({ name: "feat", force: false, keepGit: true });

    // footprintFactory.build must receive target with physicalName = "code_dst_v2"
    expect(buildCalls).toHaveLength(1);
    expect((buildCalls[0].target as { physicalName: string }).physicalName).toBe("code_dst_v2");
  });

  it("falls back to _v1 when resolveActive throws for the target", async () => {
    const worktreeEntry = {
      collectionName: "code_dst",
      worktreeOf: "code_src",
      worktreeName: "feat",
      path: "/wt",
      name: "proj-worktree-feat",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      codegraphEnabled: false,
    };
    const { deps, buildCalls } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.qdrant.aliases.resolveActive = vi.fn(async (name: string) => {
      if (name === "code_src") return "code_src_v1";
      throw new Error("collection not found");
    });

    const ops = new WorktreeProvisioner(deps);
    await ops.remove({ name: "feat", force: false, keepGit: true });

    expect(buildCalls).toHaveLength(1);
    expect((buildCalls[0].target as { physicalName: string }).physicalName).toBe("code_dst_v1");
  });
});

// ── Best-effort teardown paths ────────────────────────────────────────────────
//
// Rollback and teardown are deliberately forgiving: a half-written artifact must
// not be able to strand the operation. These pin that forgiveness so a future
// refactor cannot turn a swallowed cleanup failure into a thrown one.

describe("WorktreeProvisioner teardown resilience", () => {
  const worktreeEntry = {
    collectionName: "code_dst",
    worktreeOf: "code_src",
    path: "/repo/wt",
    name: "proj-worktree-feat",
    embeddingModel: "j",
    embeddingDimensions: 768,
    qdrantUrl: "http://h",
    codegraphEnabled: false,
  };

  it("create rollback survives an artifact whose remove also fails, and still surfaces the clone error", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({}, calls);
    deps.footprintFactory.build = vi.fn(() => ({
      context: { source: {}, target: { logicalName: "code_dst" } },
      artifacts: [
        {
          id: "qdrant",
          clone: vi.fn(async () => {
            calls.push("clone:qdrant");
          }),
          // Rollback of this one fails — must be swallowed, not masked over the real cause.
          remove: vi.fn(async () => {
            calls.push("remove:qdrant");
            throw new Error("qdrant delete refused");
          }),
        },
        {
          id: "codegraph",
          clone: vi.fn(async () => {
            calls.push("clone:codegraph");
            throw new Error("boom codegraph");
          }),
          remove: vi.fn(async () => {
            calls.push("remove:codegraph");
          }),
        },
      ],
    }));

    const ops = new WorktreeProvisioner(deps);

    await expect(ops.create({ name: "x", createGit: false })).rejects.toThrow("boom codegraph");
    // Reverse order, and the failing rollback did not stop the earlier artifact from being undone.
    expect(calls).toEqual(["clone:qdrant", "clone:codegraph", "remove:codegraph", "remove:qdrant"]);
    expect(deps.registry.record).not.toHaveBeenCalled();
  });

  it("remove falls back to the logical source name when the source alias cannot be resolved", async () => {
    const { deps, buildCalls } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => ({ path: "/repo" }));
    deps.qdrant.aliases.resolveActive = vi.fn(async () => {
      throw new Error("alias gone");
    });

    const ops = new WorktreeProvisioner(deps);
    const res = await ops.remove({ name: "feat", force: false, keepGit: true });

    expect(res).toEqual({ removed: true });
    // Source physical name degrades to the logical name rather than aborting teardown.
    expect((buildCalls[0].source as { physicalName: string }).physicalName).toBe("code_src");
    expect((buildCalls[0].target as { physicalName: string }).physicalName).toBe("code_dst_v1");
  });

  it("remove deregisters the clone even when an artifact teardown rejects", async () => {
    const { deps } = makeDeps();
    deps.registry.findWorktree = vi.fn(() => worktreeEntry);
    deps.registry.get = vi.fn(() => ({ path: "/repo" }));
    const removed: string[] = [];
    deps.footprintFactory.build = vi.fn(() => ({
      context: { source: {}, target: { logicalName: "code_dst" } },
      artifacts: [
        {
          id: "qdrant",
          clone: vi.fn(),
          remove: vi.fn(async () => {
            removed.push("qdrant");
          }),
        },
        {
          id: "stats",
          clone: vi.fn(),
          remove: vi.fn(async () => {
            removed.push("stats");
            throw new Error("stats file locked");
          }),
        },
      ],
    }));

    const ops = new WorktreeProvisioner(deps);
    const res = await ops.remove({ name: "feat", force: false, keepGit: true });

    expect(res).toEqual({ removed: true });
    expect(removed).toEqual(["stats", "qdrant"]);
    expect(deps.registry.remove).toHaveBeenCalledWith("code_dst");
  });
});

/**
 * bd tea-rags-mcp-dxa9w — a worktree entry is read back BY PATH, so the path it
 * is written under has to be the canonical one.
 *
 * Registry entries are stored realpath'd and `findByPath` is an exact compare.
 * The worktree directory does not exist yet when `create` runs, so the spelling
 * is canonicalized as far as it can be — through the parent that does exist —
 * and a symlinked ancestor (macOS `/var` → `/private/var`) stops producing an
 * entry no reader ever resolves to.
 */
describe("WorktreeProvisioner.create path canonicalization", () => {
  const created: string[] = [];

  function tmpDirFor(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("records the canonical worktree path, so findByPath finds it again", async () => {
    const parent = tmpDirFor("dxa9w-wt-parent-");
    const viaSymlink = join(tmpDirFor("dxa9w-wt-link-"), "as-symlink");
    symlinkSync(parent, viaSymlink);
    const { deps, recorded } = makeDeps();
    const registryByPath = new Map<string, unknown>();
    deps.registry.findByPath = vi.fn((p: string) => registryByPath.get(p) ?? null);
    deps.registry.record = vi.fn((e: Record<string, unknown>) => {
      recorded.push(e);
      registryByPath.set(e.path as string, e);
    });

    const res = await new WorktreeProvisioner(deps).create({
      name: "wt",
      path: join(viaSymlink, "wt"),
      from: "proj",
      createGit: false,
    });

    const canonical = join(realpathSync(parent), "wt");
    expect(res.worktreePath).toBe(canonical);
    expect(recorded[0].path).toBe(canonical);
    // The assertion that matters: a later reader, which canonicalizes, finds it.
    expect(deps.registry.findByPath(canonical)).not.toBeNull();
  });
});
