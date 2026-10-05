/**
 * Import-direction guard for the two cli LEAF files the 89k7k.22 rescan
 * flagged (bd tea-rags-mcp-nkstp).
 *
 * `src/cli/call/project-env.ts` and `src/cli/prime/run-prime.ts` are leaves:
 * they hold no composition duty, yet both carried a RUNTIME import of the api
 * assembly barrel (`core/api/index.js`, instability 0.92) to reach the
 * collection-resolver functions — and the SDP scan read each edge as a stable
 * file leaning on the markedly-less-stable assembly seam. The remedy is the
 * 89k7k.9 playbook (comment on the bead): the capability arrives as an
 * INJECTION typed by the App method signature — the type IS the contract, an
 * App satisfies it directly — and the caller (the composition actor: `call`,
 * `prime`) passes the resolver it constructs. The leaves keep no assembly
 * edge; the actors keep theirs, as ratified.
 *
 * Part 1 pins the direction over the two files (same mechanism as
 * `tests/core/api/public/sdp-runtime-import-direction.test.ts`); part 2 pins
 * the two new App queries through a wired App, mock-free, mirroring
 * `tests/core/api/app-domain-queries.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../src/core/adapters/qdrant/client.js";
import { createApp, type App, type AppDeps, type ExploreFacade, type IngestFacade } from "../../src/core/api/index.js";
import { ProjectRegistryOps } from "../../src/core/api/internal/ops/project-registry-ops.js";
import type { Reranker } from "../../src/core/domains/explore/reranker.js";
import type { IndexDriftReporter } from "../../src/core/domains/maintenance/drift/index.js";
import { CollectionRegistry } from "../../src/core/domains/maintenance/registry/index.js";
import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../core/__helpers__/git-working-tree-fixture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The two flagged leaves and the capability each must receive by injection. */
const FLAGGED_LEAVES: readonly { file: string; injectedType: string }[] = [
  { file: "src/cli/call/project-env.ts", injectedType: 'App["resolveBaseIndexEntry"]' },
  { file: "src/cli/prime/run-prime.ts", injectedType: 'App["createPathCollectionResolver"]' },
];

interface RuntimeImport {
  names: string[];
  specifier: string;
}

/** Named-form import statements carrying at least one RUNTIME clause (`import type` is erased, not an edge). */
function runtimeNamedStatements(text: string): RuntimeImport[] {
  const statements: RuntimeImport[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const isTypeStatement = match[1] !== undefined;
    const names = match[2]
      .split(",")
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !/^type\s+/.test(clause));
    if (isTypeStatement || names.length === 0) continue;
    statements.push({ names, specifier: match[3] });
  }
  return statements;
}

/** Resolve a relative specifier from `fileRel` to a repo-relative module path, extension-normalized. */
function resolveFrom(fileRel: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const segments = [...fileRel.split("/").slice(0, -1), ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  const joined = resolved.join("/");
  return joined.replace(/\.js$/, ".ts");
}

describe("cli leaves take the path-resolution capability by injection, not from the assembly barrel", () => {
  it("holds no runtime import of the api assembly barrel in either flagged leaf", () => {
    const offenders: string[] = [];
    for (const { file } of FLAGGED_LEAVES) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeNamedStatements(text)) {
        if (resolveFrom(file, statement.specifier) !== "src/core/api/index.ts") continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names the injected capability by the App method type in each flagged leaf", () => {
    for (const { file, injectedType } of FLAGGED_LEAVES) {
      expect(readFileSync(join(ROOT, file), "utf-8"), `${file} must type the injection as ${injectedType}`).toContain(
        injectedType,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the two App queries behave as the free functions they surface
// ---------------------------------------------------------------------------

const registryDir = mkdtempSync(join(tmpdir(), "composition-actor-direction-"));
const tempDirs: string[] = [];
afterAll(() => {
  rmSync(registryDir, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Wired the way app-domain-queries does — mock-free delegation behind createApp. */
function makeApp() {
  const deps: AppDeps = {
    qdrant: {} as QdrantManager,
    embeddings: {} as EmbeddingProvider,
    explore: {} as ExploreFacade,
    ingest: {} as IngestFacade,
    reranker: {
      getDescriptorInfo: vi.fn().mockReturnValue([]),
      getPresetNames: vi.fn().mockReturnValue([]),
      getPresetDetails: vi.fn().mockReturnValue([]),
      getPayloadSignals: vi.fn().mockReturnValue([]),
    } as unknown as Reranker,
    driftReporter: {} as IndexDriftReporter,
    projectRegistryOps: new ProjectRegistryOps({ registry: new CollectionRegistry(registryDir) }),
    quantizationScalar: true,
    turboQuant: true,
  };
  return createApp(deps);
}

function recordedRegistry(entryPath?: string): { registry: CollectionRegistry; entryDir: string } {
  const entryDir = entryPath ?? tempDir("composition-actor-entry-");
  const registry = new CollectionRegistry(tempDir("composition-actor-reg-"));
  registry.record({
    collectionName: "code_0",
    path: entryDir,
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://q:6333",
    indexedAt: "2026-10-01T00:00:00.000Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 1,
  });
  return { registry, entryDir };
}

describe("App.resolveBaseIndexEntry", () => {
  it("answers the entry that claims the path", () => {
    const app = makeApp();
    const { registry, entryDir } = recordedRegistry();
    const entry = app.resolveBaseIndexEntry(registry, entryDir);
    expect(entry?.collectionName).toBe("code_0");
  });

  it("answers null for a path no entry claims and no repository encloses", () => {
    const app = makeApp();
    const { registry } = recordedRegistry();
    expect(app.resolveBaseIndexEntry(registry, tempDir("composition-actor-unclaimed-"))).toBeNull();
  });

  it("reads a linked worktree through its repository's entry", { timeout: 60_000 }, () => {
    const app = makeApp();
    const fixture: GitWorkingTreeFixture = createGitWorkingTreeFixture();
    try {
      const { registry } = recordedRegistry(fixture.mainRoot);
      const tree = fixture.addWorktree("a");
      expect(app.resolveBaseIndexEntry(registry, tree)?.collectionName).toBe("code_0");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("App.createPathCollectionResolver", () => {
  it("resolves a claimed path to the entry's collection name", async () => {
    const app = makeApp();
    const { registry, entryDir } = recordedRegistry();
    const alias = await app.createPathCollectionResolver(registry)(entryDir);
    expect(alias).toBe("code_0");
  });

  it("is deterministic for an unregistered path — the hash a later index writes it under", async () => {
    const app = makeApp();
    const { registry } = recordedRegistry();
    const path = tempDir("composition-actor-unregistered-");
    const first = await app.createPathCollectionResolver(registry)(path);
    expect(first).toBe(await app.createPathCollectionResolver(new CollectionRegistry(registryDir))(path));
  });
});

describe("an App satisfies the injected cli capability types directly", () => {
  it("binds to the same shape the leaves name", () => {
    const app = makeApp();
    const asCallSeesIt: App["resolveBaseIndexEntry"] = app.resolveBaseIndexEntry.bind(app);
    const asPrimeSeesIt: App["createPathCollectionResolver"] = app.createPathCollectionResolver.bind(app);
    expect(asCallSeesIt).toBeTypeOf("function");
    expect(asPrimeSeesIt).toBeTypeOf("function");
  });
});
