/**
 * `tea-rags qdrant recover` — clear a failed Qdrant optimizer (bd tea-rags-mcp-ye5o).
 *
 * The explicit write path behind the `Run:` line `get_index_status` and
 * `prime` print when a collection's optimizer reports an error. The work is
 * `OptimizerRecoveryOps#recover`; this module owns addressing, rendering and
 * the exit code, over injected deps so tests use object literals.
 */

import { resolve } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import {
  TeaRagsError,
  type OptimizerRecoveryOps,
  type OptimizerRecoveryOutcome,
  type OptimizerRecoveryTarget,
} from "../../core/api/public/index.js";

export interface QdrantRecoverArgs {
  project?: string;
  path?: string;
  json: boolean;
}

export interface QdrantRecoverDeps {
  recovery: Pick<OptimizerRecoveryOps, "recover">;
  out: (line: string) => void;
  errOut: (line: string) => void;
  exit: (code: number) => void;
}

/** Alias when given, else the (absolute) path — cwd when neither is. */
function recoveryTarget(args: QdrantRecoverArgs): OptimizerRecoveryTarget {
  return args.project ? { project: args.project } : { path: resolve(args.path ?? process.cwd()) };
}

function describeOutcome(result: OptimizerRecoveryOutcome): string {
  if (result.outcome === "nothing-to-do") {
    return `qdrant recover: optimizer of ${result.collectionName} is ${result.optimizerStatus} — nothing to do`;
  }
  return (
    `qdrant recover: optimizer error on ${result.collectionName} cleared ` +
    `(was ${result.previousOptimizerStatus}, now ${result.optimizerStatus})`
  );
}

export async function runQdrantRecover(args: QdrantRecoverArgs, deps: QdrantRecoverDeps): Promise<void> {
  try {
    const result = await deps.recovery.recover(recoveryTarget(args));
    deps.out(args.json ? JSON.stringify(result) : describeOutcome(result));
    deps.exit(0);
  } catch (err) {
    if (!(err instanceof TeaRagsError)) throw err;
    if (args.json) {
      deps.out(JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint } }));
    } else {
      deps.errOut(`qdrant recover: ${err.message}`);
      deps.errOut(err.hint);
    }
    deps.exit(1);
  }
}

/**
 * Production deps. The Qdrant connection is opened inside `recover`, so a
 * backend that cannot be resolved or reached fails through the same typed-error
 * rendering as the recovery itself. It is the backend the PROJECT's registry
 * entry addresses — an embedded project reattaches the daemon, a stale port is
 * never dialled — else the configured default. The embedded daemon ref is
 * released on exit.
 */
function defaultDeps(): QdrantRecoverDeps {
  let release: (() => void) | undefined;

  const recover = async (target: OptimizerRecoveryTarget): Promise<OptimizerRecoveryOutcome> => {
    const { parseAppConfig } = await import("../../bootstrap/config/index.js");
    // The ops class is assembly — api root barrel, not the public contract
    // surface (bd tea-rags-mcp-89k7k.22); the addressing types stay public.
    const { OptimizerRecoveryOps: Ops } = await import("../../core/api/index.js");
    const { CollectionRegistry, EMBEDDED_MARKER, QdrantManager, resolveQdrantUrl, resolveRegistryQdrantBackend } =
      await import("../../core/api/public/index.js");

    const config = parseAppConfig();
    const registry = new CollectionRegistry(config.paths.appData, { envCodeDefaults: resolveRegistryEnvCodeDefaults });
    const entry = target.project ? registry.findByName(target.project) : registry.findByPath(target.path ?? "");
    const backend = entry ? resolveRegistryQdrantBackend(entry) : { kind: "unaddressed" as const };
    const qdrantUrl =
      backend.kind === "embedded" ? EMBEDDED_MARKER : backend.kind === "external" ? backend.url : config.qdrantUrl;
    const resolution = await resolveQdrantUrl(qdrantUrl, config.paths.appData);
    if (resolution.mode === "embedded") ({ release } = resolution);
    const qdrant = new QdrantManager(resolution.url, config.qdrantApiKey);
    return new Ops({ registry, qdrant }).recover(target);
  };

  return {
    recovery: { recover },
    out: (line) => process.stdout.write(`${line}\n`),
    errOut: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => {
      release?.();
      process.exit(code);
    },
  };
}

/** `tea-rags qdrant <recover>` — operator actions on the project's Qdrant collection. */
export const qdrantCommand: CommandModule = {
  command: "qdrant",
  describe: "Operate on the project's Qdrant collection (recover)",
  builder: (yargs: Argv) =>
    yargs
      .command(
        "recover",
        "Clear a failed Qdrant optimizer: re-apply the collection's current optimizer config " +
          "(Qdrant 1.18 recreates the optimizer) and verify the error is gone. No-op when the optimizer is healthy.",
        (y) =>
          y
            .option("project", { type: "string", describe: "Project alias from the registry" })
            .option("path", { type: "string", describe: "Project path (default: cwd) when no alias is given" })
            .conflicts("project", "path")
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        async (argv) => {
          const args: QdrantRecoverArgs = { project: argv.project, path: argv.path, json: Boolean(argv.json) };
          await runQdrantRecover(args, defaultDeps());
        },
      )
      .demandCommand(1)
      .strict(),
  handler: () => {
    // never reached — yargs delegates to subcommands
  },
};
