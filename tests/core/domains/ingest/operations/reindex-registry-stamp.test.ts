/**
 * ReindexingOperations.reindexChanges — the registry entry on QUIET runs
 * (bd tea-rags-mcp-zf3x0).
 *
 * The registry entry carries the git state, the timestamp and the point count
 * the index represents, and `CommitDriftMonitor` reads that git stamp back to
 * decide whether the index has fallen behind HEAD. Only the changes path ever
 * refreshed it: both early returns of `reindexChanges` — nothing changed, and
 * nothing but deletions — finished their marker/snapshot work and returned
 * without recording.
 *
 * The consequence is a drift axis that never clears. A repository whose index
 * is current but whose working tree went quiet keeps reporting commit drift
 * against a stamp from whichever run last had a file to chunk, and re-running
 * the reindex does not fix it — the quiet run is exactly the run that skips the
 * write. Observed on the tea-rags self-index: the registry sat on a commit and
 * a chunk count several runs old while every incremental since returned
 * "completed".
 *
 * Driven through `IngestFacade` against a real `CollectionRegistry`, mirroring
 * `pipeline/base-registry.test.ts`: the defect is in which return statements
 * reach the write, so only a composed run can show it.
 */

import { promises as fs, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import type { RecordEntryInput } from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import type { IngestCodeConfig } from "../../../../../src/core/types.js";

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
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("ReindexingOperations.reindexChanges — registry stamp on quiet runs (zf3x0)", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;
  let registryDir: string;
  let registry: CollectionRegistry;
  let recorded: RecordEntryInput[];

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    // File-based git fixture (same shape as base-registry.test.ts): the
    // finalize reads `.git` directly through infra/repo-git-state, and the
    // commit stamp is the whole point of this spec. Written BEFORE the first
    // index so the quiet run really is quiet — none of these files carry a
    // supported extension, so the scanner never sees them either way.
    mkdirSync(join(codebaseDir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(codebaseDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(codebaseDir, ".git", "refs", "heads", "main"), "feedface\n");

    registryDir = mkdtempSync(join(tmpdir(), "tea-rags-registry-"));
    registry = new CollectionRegistry(registryDir);
    recorded = [];
    vi.spyOn(registry, "record").mockImplementation((entry: RecordEntryInput) => {
      recorded.push(entry);
    });

    qdrant = new MockQdrantManager() as any;
    Object.defineProperty(qdrant, "url", { value: "http://localhost:6333", configurable: true });
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings,
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      collectionRegistry: registry,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
    rmSync(registryDir, { recursive: true, force: true });
  });

  /** The alias the run addresses, and the canonical path it recorded against. */
  async function indexedCollection(): Promise<string> {
    const status = await ingest.getIndexStatus(codebaseDir);
    return status.collectionName!;
  }

  function expectStampedEntry(entry: RecordEntryInput, collectionName: string): void {
    expect(entry.collectionName).toBe(collectionName);
    // validatePath canonicalises (macOS resolves /var -> /private/var).
    expect(entry.path.endsWith(codebaseDir) || codebaseDir.endsWith(entry.path)).toBe(true);
    expect(entry.git).toEqual({
      indexedBranch: "main",
      indexedCommit: "feedface",
      indexedDirty: false,
    });
    expect(entry.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.chunksCount).toBeGreaterThanOrEqual(0);
  }

  it("records the registry entry on a zero-change run", async () => {
    await createTestFile(codebaseDir, "quiet.ts", "export const v = 1;\nconsole.log('quiet');");
    await ingest.indexCodebase(codebaseDir);
    const collectionName = await indexedCollection();
    recorded.length = 0;

    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesAdded).toBe(0);
    expect(stats.filesModified).toBe(0);
    expect(stats.filesDeleted).toBe(0);
    expect(stats.filesRetried).toBe(0);
    expect(recorded).toHaveLength(1);
    expectStampedEntry(recorded[0], collectionName);
  });

  it("records the registry entry on a deletion-only run", async () => {
    await createTestFile(codebaseDir, "gone.ts", "export const v1 = 1;\nconsole.log('gone');");
    await createTestFile(codebaseDir, "kept.ts", "export const v2 = 2;\nconsole.log('kept');");
    await ingest.indexCodebase(codebaseDir);
    const collectionName = await indexedCollection();
    recorded.length = 0;

    await fs.unlink(join(codebaseDir, "gone.ts"));
    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesDeleted).toBe(1);
    expect(stats.filesAdded).toBe(0);
    expect(stats.filesModified).toBe(0);
    expect(recorded).toHaveLength(1);
    expectStampedEntry(recorded[0], collectionName);
  });

  it("records the registry entry exactly once on a run that has files to chunk", async () => {
    // The changes path already recorded in `finalizeReindex`; adding the quiet
    // returns must not give it a second write.
    await createTestFile(codebaseDir, "first.ts", "export const v1 = 1;\nconsole.log('first');");
    await ingest.indexCodebase(codebaseDir);
    const collectionName = await indexedCollection();
    recorded.length = 0;

    await createTestFile(codebaseDir, "second.ts", "export const v2 = 2;\nconsole.log('second');");
    const stats = await ingest.reindexChanges(codebaseDir);

    expect(stats.filesAdded).toBe(1);
    expect(recorded).toHaveLength(1);
    expectStampedEntry(recorded[0], collectionName);
  });
});
