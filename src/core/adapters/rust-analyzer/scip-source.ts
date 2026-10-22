/**
 * The `RustAnalyzerScipSource` port bound to the host (bd s3i8m.6 R2b):
 * discovery + the supervised `rust-analyzer scip` run + its disk cache. Built
 * in the thread that resolves, from plain config, the way
 * `processRustExternalSignatureSources` is.
 */
import type {
  RustAnalyzerScipAcquisition,
  RustAnalyzerScipSource,
  RustAnalyzerScipSourceConfig,
} from "../../contracts/types/language.js";
import {
  createRustAnalyzerResolver,
  defaultRustAnalyzerDiscoveryDeps,
  discoverRustAnalyzer,
  RUST_ANALYZER_PATH_ENV,
  type RustAnalyzerExecutable,
} from "./rust-analyzer-executable.js";
import {
  defaultRustAnalyzerScipRunnerDeps,
  runRustAnalyzerScip,
  type RustAnalyzerScipRunnerDeps,
  type RustAnalyzerScipRunOutcome,
} from "./scip-runner.js";

/** Host collaborators, substituted by tests. */
export interface RustAnalyzerScipSourceDeps {
  discover: (projectRoot: string) => RustAnalyzerExecutable | null;
  run: typeof runRustAnalyzerScip;
  runnerDeps: () => RustAnalyzerScipRunnerDeps;
}

/** The source over `config`; acquisitions are `skipped/disabled` when the slot is off. */
export function createRustAnalyzerScipSource(
  config: RustAnalyzerScipSourceConfig,
  deps: RustAnalyzerScipSourceDeps = defaultRustAnalyzerScipSourceDeps(config),
): RustAnalyzerScipSource {
  return {
    acquire: async ({ projectRoot, admission }): Promise<RustAnalyzerScipAcquisition> => {
      if (!config.enabled) return { kind: "skipped", reason: "disabled" };
      const executable = deps.discover(projectRoot);
      if (executable === null) return { kind: "skipped", reason: "noBinary" };
      const outcome = await deps.run(
        {
          projectRoot,
          executable,
          exec: config.exec,
          timeoutSec: config.timeoutSec,
          maxRssMb: config.maxRssMb,
          admission: config.spawn === "never" ? () => "reuseOnly" : admission,
        },
        deps.runnerDeps(),
      );
      return acquisitionOf(outcome);
    },
  };
}

const processSources = new Map<string, RustAnalyzerScipSource>();

/**
 * One source per distinct config per process, so discovery (memoized per
 * project root) and the runner deps are shared by every factory the thread
 * builds.
 */
export function processRustAnalyzerScipSource(config: RustAnalyzerScipSourceConfig): RustAnalyzerScipSource {
  const key = JSON.stringify(config);
  let source = processSources.get(key);
  if (source === undefined) {
    source = createRustAnalyzerScipSource(config);
    processSources.set(key, source);
  }
  return source;
}

function defaultRustAnalyzerScipSourceDeps(config: RustAnalyzerScipSourceConfig): RustAnalyzerScipSourceDeps {
  const env = config.path ? { ...process.env, [RUST_ANALYZER_PATH_ENV]: config.path } : process.env;
  const discover = createRustAnalyzerResolver((projectRoot) =>
    discoverRustAnalyzer(defaultRustAnalyzerDiscoveryDeps(projectRoot, env)),
  );
  let runnerDeps: RustAnalyzerScipRunnerDeps | undefined;
  return {
    discover,
    run: runRustAnalyzerScip,
    runnerDeps: () => (runnerDeps ??= defaultRustAnalyzerScipRunnerDeps()),
  };
}

function acquisitionOf(outcome: RustAnalyzerScipRunOutcome): RustAnalyzerScipAcquisition {
  switch (outcome.kind) {
    case "indexed":
      return {
        kind: "indexed",
        index: outcome.index,
        cacheHit: outcome.cacheHit,
        toolchainSkew: outcome.toolchainSkew,
        ...(outcome.stats ? { wallMs: outcome.stats.wallMs, peakRssMb: outcome.stats.peakRssMb } : {}),
      };
    case "latched":
      return {
        kind: "latched",
        reason: outcome.reason,
        detail: outcome.detail,
        ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
      };
    case "skipped":
      return outcome;
  }
}
