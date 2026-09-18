/**
 * Which registered sibling may seed a new worktree's first index, and whether
 * its index is interchangeable with what THIS run would build (bd
 * tea-rags-mcp-k8gac). The gate is a pure stamp comparison: every axis the
 * drift monitors read has to agree, or the seeded collection would report drift
 * a fresh index would not.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EMBEDDED_MARKER } from "../../../../src/core/adapters/qdrant/embedded/daemon.js";
import type { CollectionEntry } from "../../../../src/core/contracts/types/registry.js";
import {
  checkWorktreeSeedCompatibility,
  findWorktreeSeedCandidates,
  type WorktreeSeedBuildIdentity,
  type WorktreeSeedSourceStamps,
} from "../../../../src/core/domains/maintenance/worktree/worktree-seed-source.js";

const TEST_TIMEOUT = 60000;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function entry(over: Partial<CollectionEntry> & Pick<CollectionEntry, "collectionName" | "path">): CollectionEntry {
  return {
    name: null,
    embeddingModel: "nomic",
    embeddingDimensions: 768,
    qdrantUrl: EMBEDDED_MARKER,
    qdrantEmbedded: true,
    codegraphEnabled: true,
    env: { INGEST_CHUNK_SIZE: "2500", TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12", QDRANT_TUNE_UPSERT_BATCH_SIZE: "100" },
    languageVersions: {
      typescript: { chunking: 3, walker: 4, codegraphSchema: 2 },
      "*": { chunking: 2, walker: 5, codegraphSchema: 1 },
    },
    indexedAt: "2026-09-01T00:00:00Z",
    teaRagsVersion: "1.42.0",
    chunksCount: 10,
    ...over,
  };
}

const PAYLOAD_KEYS = ["relativePath", "git.file.ageDays", "codegraph.symbols.file.fanIn", "navigation"];

function build(over: Partial<WorktreeSeedBuildIdentity> = {}): WorktreeSeedBuildIdentity {
  return {
    payloadFieldKeys: PAYLOAD_KEYS,
    languageCodeVersions: new Map([
      ["typescript", { chunking: 3, walker: 4, codegraphSchema: 2 }],
      ["ruby", { chunking: 7, walker: 9, codegraphSchema: 2 }],
      ["*", { chunking: 2, walker: 5, codegraphSchema: 1 }],
    ]),
    envSnapshot: {
      INGEST_CHUNK_SIZE: "2500",
      TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
      QDRANT_TUNE_UPSERT_BATCH_SIZE: "300",
    },
    embeddingModel: "nomic",
    codegraphEnabled: true,
    qdrant: { embedded: true, url: "http://127.0.0.1:61234" },
    ...over,
  };
}

function source(
  over: Partial<CollectionEntry> = {},
  stats?: WorktreeSeedSourceStamps["stats"],
): WorktreeSeedSourceStamps {
  return {
    entry: entry({ collectionName: "code_main", path: "/repo/main", ...over }),
    stats:
      stats === undefined ? { payloadFieldKeys: PAYLOAD_KEYS, distributions: { language: { typescript: 40 } } } : stats,
  };
}

describe("checkWorktreeSeedCompatibility", () => {
  it("accepts a sibling whose every stamp matches this run — runtime tuning may differ", () => {
    expect(checkWorktreeSeedCompatibility(source(), build())).toBeUndefined();
  });

  it("rejects a sibling on another Qdrant backend", () => {
    const rejection = checkWorktreeSeedCompatibility(
      source({ qdrantUrl: "http://qdrant.internal:6333", qdrantEmbedded: false }),
      build(),
    );
    expect(rejection?.reason).toBe("qdrant-backend");
  });

  it("accepts an external sibling on the very URL this run talks to", () => {
    const external = { qdrantUrl: "http://qdrant.internal:6333", qdrantEmbedded: false };
    expect(
      checkWorktreeSeedCompatibility(
        source(external),
        build({ qdrant: { embedded: false, url: "http://qdrant.internal:6333" } }),
      ),
    ).toBeUndefined();
  });

  it("rejects a sibling embedded by another model", () => {
    const rejection = checkWorktreeSeedCompatibility(source({ embeddingModel: "jina-code" }), build());
    expect(rejection?.reason).toBe("embedding-model");
    expect(rejection?.detail).toContain("jina-code");
  });

  it("rejects a sibling whose recorded payload keys differ from this build's", () => {
    const rejection = checkWorktreeSeedCompatibility(
      source({}, { payloadFieldKeys: ["relativePath", "navigation"], distributions: { language: { typescript: 1 } } }),
      build(),
    );
    expect(rejection?.reason).toBe("payload-schema");
  });

  it("rejects a sibling with no stats cache — its payload keys cannot be proven", () => {
    expect(checkWorktreeSeedCompatibility(source({}, null), build())?.reason).toBe("payload-schema");
  });

  it("rejects a sibling indexed by another revision of a language it contains", () => {
    const rejection = checkWorktreeSeedCompatibility(
      source({
        languageVersions: {
          typescript: { chunking: 2, walker: 4, codegraphSchema: 2 },
          "*": build().languageCodeVersions?.get("*") ?? {},
        },
      }),
      build(),
    );
    expect(rejection?.reason).toBe("language-versions");
    expect(rejection?.detail).toContain("typescript.chunking");
  });

  it("rejects a sibling whose shared (`*`) versions moved, whatever languages it holds", () => {
    const rejection = checkWorktreeSeedCompatibility(
      source({
        languageVersions: {
          typescript: { chunking: 3, walker: 4, codegraphSchema: 2 },
          "*": { chunking: 2, walker: 4, codegraphSchema: 1 },
        },
      }),
      build(),
    );
    expect(rejection?.reason).toBe("language-versions");
    expect(rejection?.detail).toContain("*.walker");
  });

  it("ignores a language the sibling does not contain — this run embeds those files itself", () => {
    // `ruby` is declared by the build and absent from the sibling's stamp; the
    // sibling holds no ruby points, so nothing it hands over was built by an
    // older ruby revision.
    expect(checkWorktreeSeedCompatibility(source(), build())).toBeUndefined();
  });

  it("rejects a sibling whose chunk-shaping env differs from this run's", () => {
    const rejection = checkWorktreeSeedCompatibility(
      source(),
      build({ envSnapshot: { INGEST_CHUNK_SIZE: "1800", TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12" } }),
    );
    expect(rejection?.reason).toBe("index-env");
    expect(rejection?.detail).toContain("INGEST_CHUNK_SIZE");
  });

  it("rejects a sibling whose codegraph flag differs from this run's", () => {
    const rejection = checkWorktreeSeedCompatibility(source({ codegraphEnabled: false }), build());
    expect(rejection?.reason).toBe("index-env");
    expect(rejection?.detail).toContain("CODEGRAPH_ENABLED");
  });

  it("reads a legacy sibling's env from the deprecated `tuning` field", () => {
    const rejection = checkWorktreeSeedCompatibility(
      source({ env: undefined, tuning: { INGEST_CHUNK_SIZE: "4000" } }),
      build(),
    );
    expect(rejection?.reason).toBe("index-env");
  });
});

describe("findWorktreeSeedCandidates", () => {
  let root: string;
  let mainCheckout: string;
  let olderWorktree: string;
  let newWorktree: string;
  let unrelated: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-seed-source-")));
    mainCheckout = join(root, "main");
    olderWorktree = join(root, "older");
    newWorktree = join(root, "new");
    unrelated = join(root, "unrelated");
    for (const repo of [mainCheckout, unrelated]) {
      mkdirSync(repo, { recursive: true });
      git(["init", "-b", "master"], repo);
      git(["config", "user.email", "test@example.com"], repo);
      git(["config", "user.name", "Test"], repo);
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      git(["add", "-A"], repo);
      git(["commit", "-m", "first"], repo);
    }
    git(["worktree", "add", "--detach", olderWorktree, "HEAD"], mainCheckout);
    git(["worktree", "add", "--detach", newWorktree, "HEAD"], mainCheckout);
  }, TEST_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("offers every OTHER working tree of the same repository, newest index first", () => {
    const main = entry({ collectionName: "code_main", path: mainCheckout, indexedAt: "2026-09-10T00:00:00Z" });
    const older = entry({ collectionName: "code_older", path: olderWorktree, indexedAt: "2026-08-01T00:00:00Z" });
    const other = entry({ collectionName: "code_other", path: unrelated, indexedAt: "2026-09-17T00:00:00Z" });
    const registry = { list: () => [older, other, main] };

    const candidates = findWorktreeSeedCandidates(registry, { path: newWorktree, collectionName: "code_new" });

    expect(candidates.map((c) => c.collectionName)).toEqual(["code_main", "code_older"]);
  });

  it("never offers the target itself — a `--name` stub registered for the path is not a sibling", () => {
    const main = entry({ collectionName: "code_main", path: mainCheckout });
    const stub = entry({ collectionName: "code_new", path: newWorktree });
    const candidates = findWorktreeSeedCandidates(
      { list: () => [stub, main] },
      { path: newWorktree, collectionName: "code_new" },
    );
    expect(candidates.map((c) => c.collectionName)).toEqual(["code_main"]);
  });

  it("offers nothing for a path that is not a git working tree", () => {
    const main = entry({ collectionName: "code_main", path: mainCheckout });
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(findWorktreeSeedCandidates({ list: () => [main] }, { path: plain, collectionName: "code_plain" })).toEqual(
      [],
    );
  });
});
