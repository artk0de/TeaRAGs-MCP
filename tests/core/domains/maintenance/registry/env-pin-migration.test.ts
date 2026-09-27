import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionEntry, RegistryFileV1 } from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import {
  migrateRegistryEnvPins,
  REGISTRY_ENV_PIN_MIGRATION_REVISION,
} from "../../../../../src/core/domains/maintenance/registry/env-pin-migration.js";

// The code defaults as the bootstrap layer would inject them — a canonical
// key → string map, the shape `buildRegistryEnvSnapshot` emits.
const CODE_DEFAULTS: Readonly<Record<string, string>> = {
  TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "5000",
  TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10",
  INGEST_TUNE_FILE_CONCURRENCY: "50",
  EMBEDDING_PROVIDER: "ollama",
};

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

function legacyFile(collections: Record<string, CollectionEntry>): RegistryFileV1 {
  return { version: 1, collections };
}

describe("migrateRegistryEnvPins (bd tea-rags-mcp-h4l6k)", () => {
  it("drops pins equal to the current code default and keeps non-default and out-of-snapshot keys", () => {
    const result = migrateRegistryEnvPins(
      legacyFile({
        code_a: entry({
          env: {
            TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10",
            INGEST_TUNE_FILE_CONCURRENCY: "25",
            EMBEDDING_PROVIDER: "ollama",
            EMBEDDING_BASE_URL: "http://gpu-box:11434",
            SOME_KEY_OUTSIDE_THE_SNAPSHOT: "x",
          },
        }),
      }),
      CODE_DEFAULTS,
    );

    expect(result).not.toBeNull();
    expect(result?.file.collections.code_a.env).toEqual({
      INGEST_TUNE_FILE_CONCURRENCY: "25",
      EMBEDDING_BASE_URL: "http://gpu-box:11434",
      SOME_KEY_OUTSIDE_THE_SNAPSHOT: "x",
    });
    expect(result?.droppedPins).toEqual([
      {
        collectionName: "code_a",
        projectName: "alpha",
        droppedKeys: ["EMBEDDING_PROVIDER", "TRAJECTORY_GIT_CHUNK_CONCURRENCY"],
      },
    ]);
  });

  it("drops TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES=10000 (the frozen pre-5000 default) but keeps any other non-default value", () => {
    const result = migrateRegistryEnvPins(
      legacyFile({
        code_a: entry({ env: { TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000" } }),
        code_b: entry({
          collectionName: "code_b",
          name: "beta",
          env: { TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "777" },
        }),
      }),
      CODE_DEFAULTS,
    );

    expect(result?.file.collections.code_a.env).toEqual({});
    expect(result?.file.collections.code_b.env).toEqual({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "777" });
    expect(result?.droppedPins).toEqual([
      { collectionName: "code_a", projectName: "alpha", droppedKeys: ["TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES"] },
    ]);
  });

  it("leaves every non-env field untouched, sticky ones included", () => {
    const sticky: Partial<CollectionEntry> = {
      name: "alpha",
      autoUpdate: { enabled: true } as CollectionEntry["autoUpdate"],
      languageVersions: { typescript: { walker: 3 } },
      worktreeOf: "code_main",
      worktreeName: "feat",
      tuning: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" },
      codegraphEnabled: true,
    };
    const before = entry({ ...sticky, env: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" } });
    const result = migrateRegistryEnvPins(legacyFile({ code_a: structuredClone(before) }), CODE_DEFAULTS);

    const { env: _env, ...rest } = result?.file.collections.code_a ?? ({} as CollectionEntry);
    const { env: _beforeEnv, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
  });

  it("keeps an emptied env as {} so replay never falls back to the legacy tuning stamp", () => {
    const result = migrateRegistryEnvPins(
      legacyFile({ code_a: entry({ env: { EMBEDDING_PROVIDER: "ollama" }, tuning: { X: "1" } }) }),
      CODE_DEFAULTS,
    );
    expect(result?.file.collections.code_a.env).toEqual({});
  });

  it("stamps the migration revision and reports no drops for entries without an env", () => {
    const result = migrateRegistryEnvPins(legacyFile({ code_a: entry() }), CODE_DEFAULTS);
    expect(result?.file.revision).toBe(REGISTRY_ENV_PIN_MIGRATION_REVISION);
    expect(result?.file.version).toBe(1);
    expect(result?.file.collections.code_a).toEqual(entry());
    expect(result?.droppedPins).toEqual([]);
  });

  it("is a no-op on a registry already at the migration revision", () => {
    const current: RegistryFileV1 = {
      version: 1,
      revision: REGISTRY_ENV_PIN_MIGRATION_REVISION,
      collections: { code_a: entry({ env: { EMBEDDING_PROVIDER: "ollama" } }) },
    };
    expect(migrateRegistryEnvPins(current, CODE_DEFAULTS)).toBeNull();
  });
});

describe("CollectionRegistry env-pin migration on load (bd tea-rags-mcp-h4l6k)", () => {
  let dir: string;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-envpin-"));
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLegacy(collections: Record<string, CollectionEntry>): void {
    writeFileSync(join(dir, "registry.json"), JSON.stringify(legacyFile(collections)), "utf-8");
  }
  function readDisk(): RegistryFileV1 {
    return JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8")) as RegistryFileV1;
  }
  const defaults = (): Readonly<Record<string, string>> => CODE_DEFAULTS;

  it("migrates a legacy registry on disk once, logging the dropped keys per project", () => {
    writeLegacy({
      code_a: entry({ env: { TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000", INGEST_TUNE_FILE_CONCURRENCY: "25" } }),
    });

    const registry = new CollectionRegistry(dir, { envCodeDefaults: defaults });
    expect(registry.get("code_a")?.env).toEqual({ INGEST_TUNE_FILE_CONCURRENCY: "25" });

    const disk = readDisk();
    expect(disk.revision).toBe(REGISTRY_ENV_PIN_MIGRATION_REVISION);
    expect(disk.version).toBe(1);
    expect(disk.collections.code_a.env).toEqual({ INGEST_TUNE_FILE_CONCURRENCY: "25" });

    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("alpha");
    expect(logged).toContain("1 pin");
    expect(logged).toContain("TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES");
  });

  it("runs once: a default-equal pin set after the migration survives the next load, with no second log", () => {
    writeLegacy({ code_a: entry({ env: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" } }) });
    new CollectionRegistry(dir, { envCodeDefaults: defaults }).get("code_a");

    // An operator deliberately re-pins a value equal to the default.
    const writer = new CollectionRegistry(dir, { envCodeDefaults: defaults });
    const { name: _name, ...current } = writer.get("code_a") as CollectionEntry;
    writer.record({ ...current, env: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" } });
    stderr.mockClear();

    const reloaded = new CollectionRegistry(dir, { envCodeDefaults: defaults });
    expect(reloaded.get("code_a")?.env).toEqual({ TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("does not touch a registry already at the migration revision", () => {
    const current: RegistryFileV1 = {
      version: 1,
      revision: REGISTRY_ENV_PIN_MIGRATION_REVISION,
      collections: { code_a: entry({ env: { EMBEDDING_PROVIDER: "ollama" } }) },
    };
    const raw = JSON.stringify(current);
    writeFileSync(join(dir, "registry.json"), raw, "utf-8");
    const provider = vi.fn(defaults);

    const registry = new CollectionRegistry(dir, { envCodeDefaults: provider });
    expect(registry.get("code_a")?.env).toEqual({ EMBEDDING_PROVIDER: "ollama" });
    expect(readFileSync(join(dir, "registry.json"), "utf-8")).toBe(raw);
    expect(provider).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("an instance without injected defaults neither migrates nor stamps the revision on flush", () => {
    writeLegacy({ code_a: entry({ env: { TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000" } }) });

    const plain = new CollectionRegistry(dir);
    plain.setName("code_a", "renamed");

    const disk = readDisk();
    expect(disk.revision).toBeUndefined();
    expect(disk.collections.code_a.env).toEqual({ TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000" });

    // The next injected open still migrates it.
    const migrated = new CollectionRegistry(dir, { envCodeDefaults: defaults });
    expect(migrated.get("code_a")?.env).toEqual({});
    expect(readDisk().revision).toBe(REGISTRY_ENV_PIN_MIGRATION_REVISION);
  });

  it("a flush after the migration preserves the revision stamp", () => {
    writeLegacy({ code_a: entry({ env: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" } }) });
    const registry = new CollectionRegistry(dir, { envCodeDefaults: defaults });
    registry.setName("code_a", "renamed");
    expect(readDisk().revision).toBe(REGISTRY_ENV_PIN_MIGRATION_REVISION);
  });

  it("a registry created from scratch is born at the migration revision", () => {
    const registry = new CollectionRegistry(dir, { envCodeDefaults: defaults });
    const { name: _n, ...fresh } = entry({ env: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10" } });
    registry.record(fresh);
    expect(readDisk().revision).toBe(REGISTRY_ENV_PIN_MIGRATION_REVISION);
    expect(new CollectionRegistry(dir, { envCodeDefaults: defaults }).get("code_a")?.env).toEqual({
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10",
    });
  });
});
