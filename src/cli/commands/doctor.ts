import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import type { EmbeddingProvider } from "../../core/adapters/embeddings/base.js";
import { QdrantManager } from "../../core/adapters/qdrant/client.js";
import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface DoctorArgs {
  json?: boolean;
  recoverRegistry?: boolean;
}

/**
 * Narrow surfaces of QdrantManager + EmbeddingProvider that runDoctor needs.
 * The `Pick` types make it trivial for tests to pass plain object mocks.
 */
interface DoctorDeps {
  qdrant: Pick<
    QdrantManager,
    "url" | "checkHealth" | "listCollections" | "getCollectionInfo" | "countPoints" | "scrollFiltered"
  >;
  embeddings: Pick<EmbeddingProvider, "checkHealth" | "getProviderName" | "getBaseUrl">;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

function statusPrefix(ok: boolean, warn = false): string {
  if (warn) return "[WARN]";
  return ok ? "[OK]  " : "[FAIL]";
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * `tea-rags doctor` — read-only infrastructure + registry health summary.
 * When `--recover-registry` is set, delegates to
 * `ProjectRegistryOps.recoverFromQdrant` to repopulate registry stubs for
 * every Qdrant collection not yet known to the registry (audit #6, #7).
 *
 * `deps` is an injection point for tests; production constructs Qdrant +
 * embeddings via the same bootstrap path the server uses.
 */
export async function runDoctor(args: DoctorArgs, deps?: DoctorDeps): Promise<void> {
  const { qdrant, embeddings } = deps ?? (await defaultDeps());
  const registry = new CollectionRegistry(resolveDataDir());

  const qdrantOk = await safe(async () => qdrant.checkHealth(), false);
  const embeddingsOk = await safe(async () => embeddings.checkHealth(), false);
  const collections = await safe(async () => qdrant.listCollections(), [] as string[]);
  const registeredBefore = new Set(registry.list().map((e) => e.collectionName));
  const orphanCount = collections.filter((c) => !registeredBefore.has(c)).length;
  const embeddingUrl = typeof embeddings.getBaseUrl === "function" ? embeddings.getBaseUrl() : undefined;

  let recovery: { recovered: number } | undefined;
  if (args.recoverRegistry) {
    const before = registeredBefore.size;
    const ops = new ProjectRegistryOps({
      registry,
      // ProjectRegistryOps expects full QdrantManager; the mock + real
      // QdrantManager both satisfy the subset of methods recoverFromQdrant
      // actually calls (listCollections, getCollectionInfo, countPoints,
      // scrollFiltered, url).
      qdrant: qdrant as never,
    });
    await ops.recoverFromQdrant();
    const after = registry.list().length;
    recovery = { recovered: after - before };
  }

  const projectCount = registry.list().length;
  const remainingOrphanCount = args.recoverRegistry ? 0 : orphanCount;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          qdrant: { url: qdrant.url, reachable: qdrantOk },
          embeddings: {
            provider: embeddings.getProviderName(),
            url: embeddingUrl,
            reachable: embeddingsOk,
          },
          registry: { projectCount, orphanCount: remainingOrphanCount },
          ...(recovery ? { recovery } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${statusPrefix(qdrantOk)} Qdrant: ${qdrant.url}\n`);
  process.stdout.write(
    `${statusPrefix(embeddingsOk)} Embeddings (${embeddings.getProviderName()})${embeddingUrl ? `: ${embeddingUrl}` : ""}\n`,
  );
  process.stdout.write(`${statusPrefix(true)} Registry: ${projectCount} project(s)\n`);
  if (recovery) {
    process.stdout.write(
      `${statusPrefix(true)} Recovered ${recovery.recovered} entry/entries from Qdrant; paths are empty — re-register them with 'tea-rags projects register --path <dir> --name <alias>' to enable alias resolution.\n`,
    );
  } else if (orphanCount > 0) {
    process.stdout.write(
      `${statusPrefix(true, true)} Registry: ${orphanCount} orphan collection(s) — run 'tea-rags doctor --recover-registry' or 'tea-rags projects orphans' to inspect\n`,
    );
  }
}

/**
 * Build the same QdrantManager + EmbeddingProvider the MCP server would use.
 * Mirrors the construction path in src/bootstrap/factory.ts:resolveInfrastructure,
 * but skips embedded-daemon spawn (doctor is read-only — connection refused is
 * a legitimate [FAIL] report).
 */
async function defaultDeps(): Promise<DoctorDeps> {
  const { parseAppConfig, getZodConfig } = await import("../../bootstrap/config/index.js");
  const { resolveQdrantUrl } = await import("../../core/adapters/qdrant/embedded/daemon.js");
  const { EmbeddingProviderFactory } = await import("../../core/adapters/embeddings/factory.js");

  const config = parseAppConfig();
  const zodConfig = getZodConfig();
  const resolution = await resolveQdrantUrl(config.qdrantUrl, config.paths.appData);
  const qdrant = new QdrantManager(resolution.url, config.qdrantApiKey);
  const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding, {
    models: config.paths.models,
    daemonSocket: config.paths.daemonSocket,
    daemonPid: config.paths.daemonPid,
  });
  return { qdrant, embeddings };
}

/**
 * `tea-rags doctor` yargs subcommand. `--recover-registry` delegates to
 * `ProjectRegistryOps.recoverFromQdrant` via `runDoctor`.
 */
export const doctorCommand: CommandModule<unknown, DoctorArgs> = {
  command: "doctor",
  describe: "Print infrastructure + registry health summary",
  builder: (yargs: Argv) =>
    yargs
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Output as JSON",
      })
      .option("recover-registry", {
        type: "boolean",
        default: false,
        describe: "Repopulate the project registry from live Qdrant state",
      }),
  handler: async (argv) => {
    await runDoctor({
      json: argv.json,
      recoverRegistry: Boolean(argv["recover-registry"]),
    });
  },
};
