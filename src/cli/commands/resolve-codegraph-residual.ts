import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import type { AppContext } from "../../bootstrap/factory.js";
import {
  collectionHoldsCodegraphData,
  CollectionRegistry,
  pickRegistryEnvSeed,
  resolveDomainEnvCodeDefaults,
  resolveRegistryEnv,
} from "../../core/api/index.js";
import { applyProjectDefaults } from "../registry-resolver.js";

export interface ResolveResidualArgs {
  path?: string;
  project?: string;
  model: string;
  /** Re-apply stored verdicts without asking the model. */
  "cache-only"?: boolean;
  json?: boolean;
}

type ResolveFn = AppContext["resolveCodegraphResidual"];
type ResidualReport = Awaited<ReturnType<ResolveFn>>;

export interface ResolveResidualDeps {
  createContext: () => Promise<Pick<AppContext, "resolveCodegraphResidual" | "cleanup">>;
  write: (text: string) => void;
  /** Progress line sink (stderr); omitted in JSON mode. */
  progress?: (text: string) => void;
}

export function formatResidualReport(report: ResidualReport): string {
  const head =
    report.outcome === "skipped"
      ? `Residual resolution (${report.mode}): skipped — ${report.reason ?? "no reason given"}\n`
      : `Residual resolution (${report.mode}): completed${report.reason ? ` — ${report.reason}` : ""}\n`;
  return (
    `${head}  sites:            ${report.sites}\n` +
    `  menu overflow:    ${report.menuOverflow}\n` +
    `  menu too small:   ${report.menuTooSmall}\n` +
    `  cache hits:       ${report.cacheHits} (+${report.groupCacheHits} group questions)\n` +
    `  groups:           ${report.groups}\n` +
    `  asked:            ${report.asked}\n` +
    `  answered:         ${report.answered}\n` +
    `  too long:         ${report.tooLong}\n` +
    `  failed groups:    ${report.failedGroups}\n` +
    `  aborted groups:   ${report.abortedGroups}\n` +
    `  requeued groups:  ${report.requeuedGroups}\n` +
    `  below threshold:  ${report.belowThreshold}\n` +
    `  sites edged:      ${report.sitesEdged}\n` +
    `  external (model): ${report.externalByModel}\n` +
    `  receiver groups:  ${report.receiverGroups} (${report.receiverGroupSites} sites)\n` +
    `  edged by group:   ${report.sitesEdgedByVerdict} by verdict, ${report.sitesEdgedByPropagation} by propagation (${report.propagationConflicts} conflicts)\n` +
    `  tournaments:      ${report.tournamentGroups} groups, ${report.tournamentRounds} rounds, ${report.tournamentQuestions} questions, ${report.groupsSkippedByBudget} skipped by budget; ${report.namePriorGroups} opened by name, ${report.earlyAcceptedGroups} accepted on block 1\n` +
    `  windowed groups:  ${report.windowedGroups}\n` +
    `  requests:         ${report.requests} (at most ${report.maxQuestionsPerRequest} questions), latency p50 ${report.requestLatencyP50Ms} ms / p95 ${report.requestLatencyP95Ms} ms, peak in flight ${report.peakInFlight}\n` +
    `  edges applied:    ${report.edgesApplied}\n` +
    `  derived metrics:  ${report.derived}\n` +
    `  time (ms):        read ${report.durations.readMs}, ask ${report.durations.askMs}, apply ${report.durations.applyMs} (recompute ${report.durations.recomputeMs}), total ${report.durations.totalMs}\n`
  );
}

/** Exit code: 0 when the pass completed, 1 when it was skipped. */
export async function runResolveCodegraphResidual(
  args: ResolveResidualArgs,
  deps: ResolveResidualDeps,
): Promise<number> {
  const path = resolve(args.path ?? process.cwd());
  const ctx = await deps.createContext();
  try {
    const report = await ctx.resolveCodegraphResidual(path, args.model, {
      mode: args["cache-only"] ? "cacheOnly" : "ask",
      ...(args.json || !deps.progress ? {} : { onProgress: (p) => deps.progress?.(`\r${p.message}`) }),
    });
    if (!args.json) deps.progress?.("\n");
    deps.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatResidualReport(report));
    return report.outcome === "completed" ? 0 : 1;
  } finally {
    await ctx.cleanup?.();
  }
}

/** Seed this process's env from the project's registry entry; the ambient env wins. */
function applyRegistryEnv(project: string | undefined, path: string): void {
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  const registry = new CollectionRegistry(dataDir, {
    envCodeDefaults: () => resolveRegistryEnvCodeDefaults(resolveDomainEnvCodeDefaults()),
    codegraphDataProbe: collectionHoldsCodegraphData,
  });
  const registryEnv = resolveRegistryEnv(pickRegistryEnvSeed(registry, { project, path }));
  for (const [key, value] of Object.entries(registryEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const resolveCodegraphResidualCommand: CommandModule<object, ResolveResidualArgs> = {
  command: "resolve-codegraph-residual",
  describe:
    "Ask a model about the call sites codegraph left ambiguous or dynamic in the current index, " +
    "and add its confident answers as model edges. Cached verdicts are reused.",
  builder: (y) =>
    y
      .option("model", {
        type: "string",
        demandOption: true,
        choices: ["kev"] as const,
        describe: "Residual model (needs CODEGRAPH_RESIDUAL_KEV_URL or CODEGRAPH_RESIDUAL_KEV_SESSION_URL).",
      })
      .option("cache-only", {
        type: "boolean",
        default: false,
        describe: "Re-apply stored verdicts without contacting the model.",
      })
      .option("project", { alias: "p", type: "string", describe: "Registered project alias." })
      .option("path", { type: "string", describe: "Project directory (default: current directory)." })
      .option("json", { type: "boolean", default: false, describe: "Print the report as JSON." }),
  handler: async (argv) => {
    const resolved = applyProjectDefaults(argv);
    const path = resolve(resolved.path ?? process.cwd());
    applyRegistryEnv(argv.project, path);
    const code = await runResolveCodegraphResidual(
      { path, model: argv.model, "cache-only": Boolean(argv["cache-only"]), json: Boolean(argv.json) },
      {
        createContext: async () => {
          const { parseAppConfig } = await import("../../bootstrap/config/index.js");
          const { createAppContext } = await import("../../bootstrap/factory.js");
          return createAppContext(parseAppConfig());
        },
        write: (text) => process.stdout.write(text),
        progress: (text) => process.stderr.write(text),
      },
    );
    process.exit(code);
  },
};
