/**
 * The `RustCallSiteSource` port bound to the host (bd s3i8m T8): the rustc
 * call-site runner behind the domain's admission contract. Built in the thread
 * that resolves, from plain config.
 *
 * One acquisition per project root is in flight at a time — two concurrent
 * `cargo check` runs would share one target directory — and an acquisition
 * whose index identity matches the previous one hands back the previous index
 * object, so a re-acquisition does not keep two decoded copies alive.
 */
import type {
  RustCallSiteAcquisition,
  RustCallSiteIndex,
  RustCallSiteSource,
  RustCallSiteSourceConfig,
} from "../../contracts/types/language.js";
import {
  acquireRustcCallSites,
  defaultRustcCallSiteRunnerDeps,
  RUSTC_DRIVER_JOBS_ENV,
  type RustcCallSiteAcquisition,
  type RustcCallSiteDiagnostics,
  type RustcCallSiteRunnerDeps,
  type RustcCallSiteRunOptions,
} from "./callsite-runner.js";
import { RUSTC_DRIVER_PATH_ENV } from "./executable.js";

/** Host collaborator, substituted by tests and by the chain tally's recording wrapper. */
export interface RustcCallSiteSourceDeps {
  acquire: (options: RustcCallSiteRunOptions) => Promise<RustcCallSiteAcquisition>;
}

/** The source over `config`; acquisitions are `skipped/disabled` when the slot is off. Never rejects. */
export function createRustcCallSiteSource(
  config: RustCallSiteSourceConfig,
  deps: RustcCallSiteSourceDeps = defaultRustcCallSiteSourceDeps(config),
): RustCallSiteSource {
  const inFlight = new Map<string, Promise<RustCallSiteAcquisition>>();
  const lastIndex = new Map<string, RustCallSiteIndex>();

  const acquireFromRunner = async (
    projectRoot: string,
    admission: RustcCallSiteRunOptions["admission"],
  ): Promise<RustCallSiteAcquisition> => {
    let outcome: RustcCallSiteAcquisition;
    try {
      outcome = await deps.acquire({
        projectRoot,
        timeoutSec: config.timeoutSec,
        maxRssMb: config.maxRssMb,
        admission: config.spawn === "never" ? () => "reuseOnly" : admission,
      });
    } catch (error) {
      return { kind: "latched", reason: "exit", detail: error instanceof Error ? error.message : String(error) };
    }
    const acquisition = acquisitionOf(outcome);
    if (acquisition.kind !== "indexed") return acquisition;
    const previous = lastIndex.get(projectRoot);
    if (previous?.identity === acquisition.index.identity) return { ...acquisition, index: previous };
    lastIndex.set(projectRoot, acquisition.index);
    return acquisition;
  };

  return {
    acquire: async ({ projectRoot, admission }): Promise<RustCallSiteAcquisition> => {
      if (!config.enabled) return { kind: "skipped", reason: "disabled" };
      const inFlightAcquisition = inFlight.get(projectRoot);
      if (inFlightAcquisition !== undefined) return inFlightAcquisition;
      const acquisition = acquireFromRunner(projectRoot, admission).finally(() => inFlight.delete(projectRoot));
      inFlight.set(projectRoot, acquisition);
      return acquisition;
    },
  };
}

const processSources = new Map<string, RustCallSiteSource>();

/**
 * One source per distinct config per process, so the in-flight guard and the
 * runner deps (driver discovery, source hash) are shared by every factory the
 * thread builds.
 */
export function processRustcCallSiteSource(config: RustCallSiteSourceConfig): RustCallSiteSource {
  const key = JSON.stringify(config);
  let callSiteSource = processSources.get(key);
  if (callSiteSource === undefined) {
    callSiteSource = createRustcCallSiteSource(config);
    processSources.set(key, callSiteSource);
  }
  return callSiteSource;
}

function defaultRustcCallSiteSourceDeps(config: RustCallSiteSourceConfig): RustcCallSiteSourceDeps {
  const env = {
    ...process.env,
    ...(config.path ? { [RUSTC_DRIVER_PATH_ENV]: config.path } : {}),
    ...(config.jobs === undefined ? {} : { [RUSTC_DRIVER_JOBS_ENV]: String(config.jobs) }),
  };
  let runnerDeps: RustcCallSiteRunnerDeps | undefined;
  return {
    acquire: async (options) => acquireRustcCallSites((runnerDeps ??= defaultRustcCallSiteRunnerDeps(env)), options),
  };
}

/** The run's unit count and the crate targets that failed under the pin, for the status line. */
function unitsOf(diagnostics: RustcCallSiteDiagnostics): { units: number; failedCrates: string[] } {
  return { units: diagnostics.unitCount, failedCrates: diagnostics.failedCrates.map((crate) => crate.target) };
}

function acquisitionOf(outcome: RustcCallSiteAcquisition): RustCallSiteAcquisition {
  const { diagnostics } = outcome;
  switch (outcome.status) {
    case "ok":
    case "partial":
      return outcome.index
        ? {
            kind: "indexed",
            index: outcome.index,
            cacheHit: false,
            wallMs: diagnostics.wallMs,
            ...unitsOf(diagnostics),
          }
        : { kind: "latched", reason: "exit", detail: "driver run produced no index" };
    case "reused":
      return outcome.index
        ? { kind: "indexed", index: outcome.index, cacheHit: true, ...unitsOf(diagnostics) }
        : { kind: "skipped", reason: "noBulkNoCache" };
    case "noCache":
      return { kind: "skipped", reason: "noBulkNoCache" };
    case "disabled":
      return { kind: "skipped", reason: "disabled" };
    case "unavailable":
      return {
        kind: "skipped",
        reason: "unavailable",
        ...(diagnostics.hint === undefined ? {} : { hint: diagnostics.hint }),
      };
    case "failed":
      if (diagnostics.latched) {
        return {
          kind: "latched",
          reason: diagnostics.latched.reason,
          detail: diagnostics.latched.detail,
          ...(diagnostics.hint === undefined ? {} : { hint: diagnostics.hint }),
        };
      }
      if (diagnostics.budget) {
        return { kind: "latched", reason: diagnostics.budget.reason, detail: diagnostics.budget.detail };
      }
      return { kind: "latched", reason: "exit", detail: diagnostics.detail ?? "rustc call-site driver failed" };
  }
}
