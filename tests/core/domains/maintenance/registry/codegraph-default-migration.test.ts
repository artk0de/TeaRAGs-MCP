import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatsCache } from "../../../../../src/core/adapters/filesystem/stats-cache.js";
import type { CollectionEntry, RegistryFileV1 } from "../../../../../src/core/contracts/types/registry.js";
import type { CollectionSignalStats } from "../../../../../src/core/contracts/types/trajectory.js";
import {
  collectionHoldsCodegraphData,
  migrateRegistryCodegraphDefault,
  REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION,
} from "../../../../../src/core/domains/maintenance/registry/codegraph-default-migration.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { REGISTRY_ENV_PIN_MIGRATION_REVISION } from "../../../../../src/core/domains/maintenance/registry/env-pin-migration.js";

function entry(over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_a",
    path: "/repo/a",
    name: "alpha",
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-09-01T00:00:00.000Z",
    teaRagsVersion: "1.40.0",
    chunksCount: 10,
    ...over,
  };
}

function fileAt(revision: number | undefined, collections: Record<string, CollectionEntry>): RegistryFileV1 {
  return { version: 1, ...(revision !== undefined ? { revision } : {}), collections };
}

const STATS: CollectionSignalStats = {
  computedAt: 1_700_000_000_000,
  perSignal: new Map(),
  perLanguage: new Map(),
  distributions: {
    totalFiles: 0,
    language: {},
    chunkType: {},
    documentation: { docs: 0, code: 0 },
    topAuthors: [],
    topBlameAuthors: [],
    othersCount: 0,
  },
};

describe("migrateRegistryCodegraphDefault", () => {
  const holds = (names: string[]) => (_dataDir: string, collectionName: string) => names.includes(collectionName);

  it("stamps an entry with no recorded flag from the data its collection holds", () => {
    const result = migrateRegistryCodegraphDefault(
      fileAt(REGISTRY_ENV_PIN_MIGRATION_REVISION, {
        code_a: entry(),
        code_b: entry({ collectionName: "code_b", name: "beta" }),
      }),
      "/data",
      holds(["code_b"]),
    );

    expect(result?.file.collections.code_a.codegraphEnabled).toBe(false);
    expect(result?.file.collections.code_b.codegraphEnabled).toBe(true);
    expect(result?.file.revision).toBe(REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION);
    expect(result?.keptOff).toEqual([{ collectionName: "code_a", projectName: "alpha" }]);
  });

  it("leaves a recorded flag untouched, whatever the data says", () => {
    const result = migrateRegistryCodegraphDefault(
      fileAt(REGISTRY_ENV_PIN_MIGRATION_REVISION, {
        code_a: entry({ codegraphEnabled: false }),
        code_b: entry({ collectionName: "code_b", codegraphEnabled: true }),
      }),
      "/data",
      holds(["code_a"]),
    );

    expect(result?.file.collections.code_a.codegraphEnabled).toBe(false);
    expect(result?.file.collections.code_b.codegraphEnabled).toBe(true);
    expect(result?.keptOff).toEqual([]);
  });

  it("is a no-op on a registry already at its revision", () => {
    expect(
      migrateRegistryCodegraphDefault(
        fileAt(REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION, { code_a: entry() }),
        "/data",
        holds([]),
      ),
    ).toBeNull();
  });

  it("waits for the env-pin migration that precedes it", () => {
    expect(migrateRegistryCodegraphDefault(fileAt(undefined, { code_a: entry() }), "/data", holds([]))).toBeNull();
  });
});

describe("collectionHoldsCodegraphData", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cg-probe-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers from the payload keys the stats cache recorded", () => {
    const stats = new StatsCache(join(dataDir, "snapshots"));
    stats.save("code_on", STATS, ["git.file.commitCount", "codegraph.file.fanIn"]);
    stats.save("code_off", STATS, ["git.file.commitCount"]);
    mkdirSync(join(dataDir, "codegraph"), { recursive: true });
    writeFileSync(join(dataDir, "codegraph", "code_off_v1.duckdb"), "");

    expect(collectionHoldsCodegraphData(dataDir, "code_on")).toBe(true);
    expect(collectionHoldsCodegraphData(dataDir, "code_off")).toBe(false);
  });

  it("falls back to a graph database on disk when no stats were recorded", () => {
    mkdirSync(join(dataDir, "codegraph"), { recursive: true });
    writeFileSync(join(dataDir, "codegraph", "code_db_v3.duckdb"), "");

    expect(collectionHoldsCodegraphData(dataDir, "code_db")).toBe(true);
    expect(collectionHoldsCodegraphData(dataDir, "code_none")).toBe(false);
  });
});

describe("CollectionRegistry codegraph default migration on load", () => {
  let dir: string;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-cgdefault-"));
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeDisk = (file: RegistryFileV1): void => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify(file), "utf-8");
  };
  const readDisk = (): RegistryFileV1 =>
    JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8")) as RegistryFileV1;
  const envCodeDefaults = () => ({});

  it("runs after the env-pin migration in one open and names the projects kept off", () => {
    writeDisk(fileAt(undefined, { code_a: entry() }));

    const registry = new CollectionRegistry(dir, { envCodeDefaults, codegraphDataProbe: () => false });

    expect(registry.get("code_a")?.codegraphEnabled).toBe(false);
    expect(readDisk().revision).toBe(REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION);
    const logged = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(logged).toContain("alpha");
    expect(logged).toContain("CODEGRAPH_ENABLED=true");
  });

  it("an instance without the probe leaves the step for the next open", () => {
    writeDisk(fileAt(REGISTRY_ENV_PIN_MIGRATION_REVISION, { code_a: entry() }));

    expect(new CollectionRegistry(dir, { envCodeDefaults }).get("code_a")?.codegraphEnabled).toBeUndefined();
    expect(readDisk().revision).toBe(REGISTRY_ENV_PIN_MIGRATION_REVISION);

    const migrated = new CollectionRegistry(dir, { envCodeDefaults, codegraphDataProbe: () => true });
    expect(migrated.get("code_a")?.codegraphEnabled).toBe(true);
  });

  it("a registry created from scratch is born past it", () => {
    const registry = new CollectionRegistry(dir, { envCodeDefaults, codegraphDataProbe: () => false });
    const { name: _n, ...fresh } = entry();
    registry.record(fresh);

    expect(readDisk().revision).toBe(REGISTRY_CODEGRAPH_DEFAULT_MIGRATION_REVISION);
    expect(
      new CollectionRegistry(dir, { envCodeDefaults, codegraphDataProbe: () => false }).get("code_a")?.codegraphEnabled,
    ).toBeUndefined();
  });
});
