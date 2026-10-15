/**
 * Codegraph on by default (bd tea-rags-mcp-2m83f.15): a project indexed
 * without codegraph before the flip keeps its state, and a reading process
 * running on the new default reports no codegraph drift for it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildRunningIndexEnvSnapshot } from "../../src/bootstrap/config/env-snapshot.js";
import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";
import {
  buildEffectiveIndexEnvSnapshot,
  disabledTrajectoryFamiliesResolver,
} from "../../src/bootstrap/effective-index-env-snapshot.js";
import { StatsCache } from "../../src/core/adapters/filesystem/stats-cache.js";
import { resolveDomainEnvCodeDefaults } from "../../src/core/api/internal/domain-env-code-defaults.js";
import type { CollectionEntry } from "../../src/core/contracts/types/registry.js";
import type { CollectionSignalStats, PayloadKeyOwner } from "../../src/core/contracts/types/trajectory.js";
import { EnvDriftMonitor } from "../../src/core/domains/maintenance/drift/env-drift-monitor.js";
import { SchemaDriftMonitor } from "../../src/core/domains/maintenance/drift/schema-drift-monitor.js";
import { collectionHoldsCodegraphData } from "../../src/core/domains/maintenance/registry/codegraph-default-migration.js";
import { CollectionRegistry } from "../../src/core/domains/maintenance/registry/collection-registry.js";

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

const OWNERS: PayloadKeyOwner[] = [
  { key: "git.file.commitCount", trajectory: "git", recomputable: true },
  { key: "codegraph.file.fanIn", trajectory: "codegraph.symbols", recomputable: true },
];

const LEGACY: CollectionEntry = {
  collectionName: "code_legacy",
  path: "/repo/legacy",
  name: "legacy",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-09-01T00:00:00.000Z",
  teaRagsVersion: "1.40.0",
  chunksCount: 10,
  env: { GIT_ADAPTER: "git" },
};

describe("a legacy project indexed without codegraph, read by a default-on process", () => {
  let dataDir: string;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cg-default-on-"));
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(dataDir, "registry.json"),
      JSON.stringify({ version: 1, collections: { code_legacy: LEGACY } }),
      "utf-8",
    );
    new StatsCache(join(dataDir, "snapshots")).save("code_legacy", STATS, ["git.file.commitCount"]);
  });
  afterEach(() => {
    stderr.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const openRegistry = (): CollectionRegistry =>
    new CollectionRegistry(dataDir, { envCodeDefaults: () => ({}), codegraphDataProbe: collectionHoldsCodegraphData });

  it("keeps the project off after the registry migration", () => {
    expect(openRegistry().get("code_legacy")?.codegraphEnabled).toBe(false);
  });

  it("reports no codegraph drift on either axis", () => {
    const registry = openRegistry();
    const statsCache = new StatsCache(join(dataDir, "snapshots"));
    const ambient: NodeJS.ProcessEnv = {};
    const payloadKeys = new SchemaDriftMonitor(
      statsCache,
      OWNERS.map((o) => o.key),
      OWNERS,
      disabledTrajectoryFamiliesResolver(registry, ambient, "server"),
    );
    const env = new EnvDriftMonitor(
      registry,
      (stored, collectionName) => buildEffectiveIndexEnvSnapshot(stored, collectionName, ambient, "server"),
      buildRunningIndexEnvSnapshot(parseAppConfigZod(ambient), resolveDomainEnvCodeDefaults()),
    );

    expect(payloadKeys.check("code_legacy")).toEqual([]);
    expect(env.check("code_legacy").filter((f) => f.subject === "CODEGRAPH_ENABLED")).toEqual([]);
  });

  it("an explicit CODEGRAPH_ENABLED=true in an invocation turns the codegraph keys back into a claim", () => {
    const registry = openRegistry();
    const resolver = disabledTrajectoryFamiliesResolver(registry, { CODEGRAPH_ENABLED: "true" }, "invocation");
    expect(resolver("code_legacy")).toEqual([]);
  });
});
