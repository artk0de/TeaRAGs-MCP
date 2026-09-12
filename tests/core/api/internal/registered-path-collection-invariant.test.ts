/**
 * bd tea-rags-mcp-dxa9w — registered path ⇒ registered collection, everywhere.
 *
 * When a project moves, `register_project` re-points the EXISTING entry at the
 * new path (`CollectionRegistry#updatePath`) so the indexed data survives the
 * move. From that moment the entry's `collectionName` and the hash of its path
 * disagree, and every surface that derives identity by hashing the path is
 * looking at a collection that does not exist: the index run built a fresh
 * `code_<hash(newPath)>` and left an orphan registry entry behind, status
 * reported "not indexed" at the path and at the alias, and prime printed the
 * same while the real index sat untouched under the registered name.
 *
 * The fixture below is that disagreement, minimal: one entry whose
 * `collectionName` is deliberately NOT `resolveCollectionName(path)`. Each test
 * is one surface, and each one failed before the resolver became the single
 * choice point.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpAutoUpdateTrigger } from "../../../../src/bootstrap/auto-update/mcp-hint.js";
import { runPrime } from "../../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../../src/cli/update-check/check-service.js";
import { unavailable } from "../../../../src/cli/update-check/types.js";
import { IngestFacade } from "../../../../src/core/api/index.js";
import { resolveCollection } from "../../../../src/core/api/internal/collection-resolver.js";
import { CollectionRegistry } from "../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { resolveCollectionName, validatePath } from "../../../../src/core/infra/collection-name.js";
import type { IngestCodeConfig } from "../../../../src/core/types.js";
import {
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../../domains/ingest/__helpers__/test-helpers.js";

const { pingMock, createAppContextMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
}));

vi.mock("../../../../src/cli/prime/qdrant-ping.js", () => ({ pingQdrant: pingMock }));
vi.mock("../../../../src/bootstrap/factory.js", () => ({ createAppContext: createAppContextMock }));
vi.mock("../../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: () => ({}),
  getZodConfig: () => ({ deprecations: [] }),
}));

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

/**
 * The collection the entry was created under, before the project moved. It is
 * not derivable from the new path — that is the whole point of the fixture.
 */
const RELOCATED_COLLECTION = "code_relocated";
const PROJECT_ALIAS = "relocated";

const created: string[] = [];

function tmpDirFor(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * A project that MOVED: its directory is new, its registry entry is the old
 * one re-pointed at it. Returns the canonical spelling of the path, since that
 * is what `CollectionRegistry#record` stores and `findByPath` compares against.
 */
async function seedRelocatedProject(options: {
  dataDir: string;
  projectDir: string;
  autoUpdate?: { enabled: boolean; targetBranch: string };
}): Promise<string> {
  const canonicalPath = await validatePath(options.projectDir);
  const registry = new CollectionRegistry(options.dataDir);
  registry.record({
    collectionName: RELOCATED_COLLECTION,
    path: canonicalPath,
    embeddingModel: "mock-model",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-09-01T00:00:00.000Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 42,
  });
  registry.setName(RELOCATED_COLLECTION, PROJECT_ALIAS);
  if (options.autoUpdate) registry.setAutoUpdate(RELOCATED_COLLECTION, options.autoUpdate);
  // The premise every assertion below rests on.
  expect(resolveCollectionName(canonicalPath)).not.toBe(RELOCATED_COLLECTION);
  return canonicalPath;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("indexing a relocated project", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let registry: CollectionRegistry;
  let projectDir: string;
  let canonicalPath: string;

  beforeEach(async () => {
    const dataDir = tmpDirFor("dxa9w-data-");
    projectDir = join(tmpDirFor("dxa9w-project-"), "codebase");
    mkdirSync(projectDir, { recursive: true });
    canonicalPath = await seedRelocatedProject({ dataDir, projectDir });
    registry = new CollectionRegistry(dataDir);

    qdrant = new MockQdrantManager() as never;
    Object.defineProperty(qdrant, "url", { value: "http://localhost:6333", configurable: true });
    const config: IngestCodeConfig = defaultTestConfig();
    ingest = new IngestFacade({
      qdrant: qdrant as never,
      embeddings: new MockEmbeddingProvider(),
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      collectionRegistry: registry,
    } as never);

    await createTestFile(projectDir, "relocated.ts", "export const value = 1;\nconsole.log(value);\n");
  });

  it("writes into the registered collection instead of minting a path-hash one", async () => {
    await ingest.indexCodebase(projectDir);

    const hashName = resolveCollectionName(canonicalPath);
    const collections = await qdrant.listCollections();
    expect(collections.filter((c) => c.startsWith(hashName))).toEqual([]);
    expect(collections.some((c) => c.startsWith(RELOCATED_COLLECTION))).toBe(true);
  });

  it("leaves no orphan registry entry beside the one that claims the path", async () => {
    await ingest.indexCodebase(projectDir);

    // The run re-records the entry it indexed; a second entry means the run
    // registered a collection nobody asked for and the alias still points at
    // the stale one.
    expect(registry.list().map((e) => e.collectionName)).toEqual([RELOCATED_COLLECTION]);
    expect(registry.get(RELOCATED_COLLECTION)?.name).toBe(PROJECT_ALIAS);
  });

  it("reports the registered collection's status for the path and for its alias", async () => {
    await ingest.indexCodebase(projectDir);

    const byPath = await ingest.getIndexStatus(projectDir);
    expect(byPath.isIndexed).toBe(true);
    expect(byPath.collectionName).toBe(RELOCATED_COLLECTION);

    // How an alias-addressed request reaches a path-shaped App method: the
    // entry's own path. It must land on the same collection.
    const byAlias = resolveCollection(registry, { project: PROJECT_ALIAS });
    expect(byAlias.collectionName).toBe(RELOCATED_COLLECTION);
    expect((await ingest.getIndexStatus(byAlias.path!)).collectionName).toBe(RELOCATED_COLLECTION);
  });
});

describe("prime at a relocated project's path", () => {
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const writeMock = vi.fn();
  let prevDataDir: string | undefined;

  beforeEach(() => {
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    process.stdout.write = writeMock as unknown as typeof process.stdout.write;
    prevDataDir = process.env.TEA_RAGS_DATA_DIR;
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    if (prevDataDir === undefined) delete process.env.TEA_RAGS_DATA_DIR;
    else process.env.TEA_RAGS_DATA_DIR = prevDataDir;
  });

  function stubUpdateService(): UpdateCheckService {
    return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
  }

  it("finds the entry by path and drives auto-update against its collection", async () => {
    const dataDir = tmpDirFor("dxa9w-prime-data-");
    const projectDir = tmpDirFor("dxa9w-prime-project-");
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    await seedRelocatedProject({ dataDir, projectDir });

    pingMock.mockResolvedValue(true);
    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: RELOCATED_COLLECTION,
          chunksCount: 42,
          lastUpdated: new Date(),
        }),
        getIndexMetrics: vi.fn().mockResolvedValue(null),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: stubUpdateService(),
    });

    const maybeSpawn = vi.fn().mockReturnValue("disabled");
    await runPrime({ path: projectDir, autoUpdateTrigger: { maybeSpawn } });

    // A null entry skips the trigger entirely — the call itself is the proof
    // the lookup resolved, and the argument is the proof it resolved right.
    expect(maybeSpawn).toHaveBeenCalledWith(RELOCATED_COLLECTION);
    expect(writeMock.mock.calls.map((c) => String(c[0])).join("")).toContain(PROJECT_ALIAS);
  });
});

describe("the MCP auto-update hint for a relocated project's path", () => {
  it("resolves the path to the registered collection", async () => {
    const dataDir = tmpDirFor("dxa9w-hint-data-");
    const repo = tmpDirFor("dxa9w-hint-repo-");
    // File-based HEAD fixture, no git spawn: HEAD is on master while the index
    // follows main, so the verdict is a branch mismatch — a message that can
    // only be rendered once the entry has been found.
    mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(repo, ".git", "refs", "heads", "master"), "abc123\n");
    const canonicalPath = await seedRelocatedProject({
      dataDir,
      projectDir: repo,
      autoUpdate: { enabled: true, targetBranch: "main" },
    });

    const trigger = buildMcpAutoUpdateTrigger(dataDir);

    expect(trigger.hintFor({ path: canonicalPath })).toBe(
      "auto-update paused — HEAD not on target main; run index_codebase to switch the index",
    );
  });
});
