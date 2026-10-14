/**
 * Effective pool-size values, pinned across the move of their DEFAULTS out of
 * `bootstrap/config` into the owning domains (bd tea-rags-mcp-umixb).
 *
 * Config passes the raw env value (undefined when unset) and the owning domain
 * applies its own default where it consumes the value. Nothing an operator can
 * observe may move: for every setting, the value the domain runs with and the
 * value the registry env snapshot records stay what they were under unset, set
 * and invalid env.
 */
import { describe, expect, it } from "vitest";

import { buildRegistryEnvSnapshot } from "../../src/bootstrap/config/env-snapshot.js";
import { buildAppConfig, parseAppConfigZod } from "../../src/bootstrap/config/index.js";
import { resolveRegistryEnvCodeDefaults } from "../../src/bootstrap/config/registry-env-code-defaults.js";
import { resolveDomainEnvCodeDefaults } from "../../src/core/api/internal/domain-env-code-defaults.js";
import {
  defaultChunkerPoolSize,
  defaultEnrichmentFilesPerThread,
} from "../../src/core/domains/ingest/pipeline/index.js";
import { defaultBlamePoolSize, GitEnrichmentProvider } from "../../src/core/domains/trajectory/git/index.js";

type ZodConfig = ReturnType<typeof parseAppConfigZod>;

interface PoolSettingRow {
  setting: string;
  /** Canonical env name first, then every alias the parser accepts. */
  envNames: readonly [string, ...string[]];
  domainDefault: () => number;
  /** The value the owning domain runs with, read where it consumes it. */
  effective: (zod: ZodConfig) => number;
}

function blamePoolSizeOfProvider(zod: ZodConfig): number {
  const provider = new GitEnrichmentProvider(buildAppConfig(zod).trajectoryIngest.trajectoryGit);
  return (provider as unknown as { config: { blamePoolSize: number } }).config.blamePoolSize;
}

const ROWS: readonly PoolSettingRow[] = [
  {
    setting: "chunkerPoolSize",
    envNames: ["INGEST_TUNE_CHUNKER_POOL_SIZE", "CHUNKER_POOL_SIZE"],
    domainDefault: defaultChunkerPoolSize,
    effective: (zod) =>
      Number(buildRegistryEnvSnapshot(zod, resolveDomainEnvCodeDefaults()).INGEST_TUNE_CHUNKER_POOL_SIZE),
  },
  {
    setting: "enrichmentFilesPerThread",
    envNames: ["INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD"],
    domainDefault: defaultEnrichmentFilesPerThread,
    effective: (zod) =>
      Number(buildRegistryEnvSnapshot(zod, resolveDomainEnvCodeDefaults()).INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD),
  },
  {
    setting: "blamePoolSize",
    envNames: ["TRAJECTORY_GIT_BLAME_POOL_SIZE"],
    domainDefault: defaultBlamePoolSize,
    effective: blamePoolSizeOfProvider,
  },
];

describe("pool-size settings keep their effective values (bd tea-rags-mcp-umixb)", () => {
  describe.each(ROWS)("$setting", ({ envNames, domainDefault, effective }) => {
    const [canonical] = envNames;

    it("unset env: the domain default, in the running domain and in the registry snapshot", () => {
      const zod = parseAppConfigZod({});
      expect(effective(zod)).toBe(domainDefault());
      expect(buildRegistryEnvSnapshot(zod, resolveDomainEnvCodeDefaults())[canonical]).toBe(String(domainDefault()));
      expect(resolveRegistryEnvCodeDefaults(resolveDomainEnvCodeDefaults(), {})[canonical]).toBe(
        String(domainDefault()),
      );
    });

    it("empty env value: treated as unset", () => {
      const zod = parseAppConfigZod({ [canonical]: "" });
      expect(effective(zod)).toBe(domainDefault());
      expect(buildRegistryEnvSnapshot(zod, resolveDomainEnvCodeDefaults())[canonical]).toBe(String(domainDefault()));
    });

    it.each(envNames)("set via %s: the operator's value wins everywhere", (envName) => {
      const zod = parseAppConfigZod({ [envName]: "3" });
      expect(effective(zod)).toBe(3);
      expect(buildRegistryEnvSnapshot(zod, resolveDomainEnvCodeDefaults())[canonical]).toBe("3");
    });

    it("invalid env value: config parsing rejects it; a fractional one truncates", () => {
      expect(() => parseAppConfigZod({ [canonical]: "not-a-number" })).toThrow();
      expect(effective(parseAppConfigZod({ [canonical]: "2.5" }))).toBe(2);
    });
  });
});
