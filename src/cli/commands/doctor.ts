import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import type { CodegraphDaemonRestartOutcome } from "../../bootstrap/codegraph-daemon-restart.js";
import {
  CollectionRegistry,
  ProjectRegistryOps,
  QdrantManager,
  QuarantineStore,
  resolveCollection,
  validatePath,
  type EmbeddingProvider,
} from "../../core/api/public/index.js";
import { IndexWorkerRegistry, indexWorkerRegistryDir } from "../index-progress/worker-registry.js";
import {
  psIndexWorkerProcessProbe,
  sweepIndexWorkers,
  type IndexWorkerProcessProbe,
  type IndexWorkerSweepOutcome,
} from "../index-progress/worker-sweep.js";

interface DoctorArgs {
  json?: boolean;
  recoverRegistry?: boolean;
  quarantine?: boolean;
  path?: string;
  "sweep-workers"?: boolean;
  "include-stalled"?: boolean;
  "dry-run"?: boolean;
  restart?: boolean;
}

/**
 * Narrow surfaces of QdrantManager + EmbeddingProvider that runDoctor needs.
 * The `Pick` types make it trivial for tests to pass plain object mocks.
 */
interface DoctorDeps {
  qdrant: Pick<
    QdrantManager,
    "url" | "checkHealth" | "listCollections" | "getCollectionInfo" | "countPoints" | "scrollFiltered"
  > & {
    /**
     * Optional — older Qdrant servers or partial mocks may omit it.
     * Used to exclude physical collections that back an alias from the orphan
     * count (mirrors FixB in src/cli/commands/projects.ts:runOrphans).
     */
    aliases?: Pick<QdrantManager["aliases"], "listAliases">;
  };
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
  // Aliased-to physical collections must NOT count as orphans — they back a
  // registered (or unregistered) alias and removing them destroys live data.
  // Mirrors FixB in src/cli/commands/projects.ts:runOrphans so `tea-rags doctor`
  // and `tea-rags projects orphans` report consistent counts.
  const aliasedTargets = await safe<Set<string>>(async () => {
    if (typeof qdrant.aliases?.listAliases !== "function") return new Set();
    const aliases = await qdrant.aliases.listAliases();
    return new Set(aliases.map((a) => a.collectionName));
  }, new Set<string>());
  const orphanCount = collections.filter((c) => !registeredBefore.has(c) && !aliasedTargets.has(c)).length;
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
  // The inverse of an orphan: an entry whose project directory is gone
  // (removed worktree, deleted fixture). Nothing re-points a NAMELESS one, so
  // it sits in the registry forever with its collection behind it — `projects
  // prune` is the sweep (bd tea-rags-mcp-qwhmy).
  const staleCount = new ProjectRegistryOps({ registry }).listStale().length;
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
          registry: { projectCount, orphanCount: remainingOrphanCount, staleCount },
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
  if (staleCount > 0) {
    process.stdout.write(
      `${statusPrefix(true, true)} Registry: ${staleCount} stale (missing directory) → tea-rags projects prune\n`,
    );
  }
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
 * `tea-rags doctor --restart` — stop ALL live build-keyed codegraph daemons
 * (two or more live builds on one machine is the normal case the build-keyed
 * daemon creates, bd tea-rags-mcp-42hno) and sweep the key directories of
 * daemons already gone. Each session's next codegraph op cold-spawns its own
 * build's daemon again — that is the restart. What may be stopped and how the
 * exit is observed is `restartCodegraphDaemons` in bootstrap; here the
 * outcome is rendered for the operator — or an agent reading `--json`.
 */
export interface DaemonRestartDoctorDeps {
  storageDir: string;
  outcomes: CodegraphDaemonRestartOutcome[];
}

export async function runDaemonRestartDoctor(args: { json?: boolean }, deps?: DaemonRestartDoctorDeps): Promise<void> {
  let resolved: DaemonRestartDoctorDeps;
  if (deps) {
    resolved = deps;
  } else {
    const { codegraphDaemonStorageDir, restartCodegraphDaemons } =
      await import("../../bootstrap/codegraph-daemon-restart.js");
    const storageDir = codegraphDaemonStorageDir(resolveDataDir());
    resolved = { storageDir, outcomes: await restartCodegraphDaemons({ storageDir }) };
  }
  const { storageDir, outcomes } = resolved;
  const stopped = outcomes.filter((o) => o.action === "stopped");
  const swept = outcomes.filter((o) => o.action === "swept");
  const wedged = outcomes.filter((o) => o.action === "exit-timeout");
  const failed = outcomes.filter((o) => o.action === "signal-failed");

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ storageDir, daemons: outcomes }, null, 2)}\n`);
    return;
  }

  if (outcomes.length === 0) {
    process.stdout.write("No live build-keyed codegraph daemon.\n");
    return;
  }
  for (const o of outcomes) {
    const pid = o.pid !== undefined ? `pid ${o.pid} ` : "";
    switch (o.action) {
      case "stopped":
        process.stdout.write(`[OK]   ${pid}stopped — ${o.keyDir}\n`);
        break;
      case "swept":
        process.stdout.write(`[OK]   orphaned key directory swept — ${o.keyDir}\n`);
        break;
      case "exit-timeout":
        process.stdout.write(
          `[WARN] ${pid}did not exit after the restart signal — wedged, left for manual inspection: ${o.keyDir}\n`,
        );
        break;
      case "signal-failed":
        process.stdout.write(`[FAIL] ${pid}could not be signalled — ${o.keyDir}\n`);
        break;
    }
  }
  const parts = [`Restarted ${stopped.length} codegraph daemon(s)`];
  if (swept.length > 0) parts.push(`swept ${swept.length} orphaned key director(ies)`);
  if (wedged.length > 0) parts.push(`${wedged.length} wedged daemon(s) left for manual inspection`);
  if (failed.length > 0) parts.push(`${failed.length} could not be signalled`);
  process.stdout.write(`${parts.join("; ")}.\n`);
}

/**
 * `tea-rags doctor --quarantine [path]` — list the poison-pill files that broke
 * indexing for a project. Human table by default; `--json` emits the full
 * structured list (path, errorCode, phase, attempts, timestamps) so an agent can
 * triage or help file a GitHub issue.
 */
export async function runQuarantineDoctor(args: { path: string; json?: boolean }): Promise<void> {
  const project = await validatePath(args.path);
  // The quarantine file is named after the collection, so it has to be the
  // collection the index actually lives in — the registry's entry when one
  // claims this path, the hash only otherwise (bd tea-rags-mcp-dxa9w).
  const { collectionName } = resolveCollection(new CollectionRegistry(resolveDataDir()), { path: project });
  const snapshotDir = join(resolveDataDir(), "snapshots");
  const entries = await new QuarantineStore(snapshotDir, collectionName).load();
  const files = [...entries.entries()].map(([path, entry]) => ({ path, ...entry }));

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ project, collectionName, count: files.length, files }, null, 2)}\n`);
    return;
  }

  if (files.length === 0) {
    process.stdout.write("No quarantined files.\n");
    return;
  }

  process.stdout.write(`Quarantined files (${files.length}) for ${collectionName}:\n`);
  for (const f of files) {
    process.stdout.write(`  ${f.path}\n`);
    process.stdout.write(`    ${f.errorCode} · phase=${f.phase} · attempts=${f.attempts} · last=${f.lastFailedAt}\n`);
    // The error message carries the human-readable reason (e.g. "AST not
    // processed") — the only field that distinguishes two same-code/same-phase
    // quarantines (a degraded-AST parse failure vs a generic parse throw).
    process.stdout.write(`    ${f.errorMessage}\n`);
  }
  process.stdout.write(
    `\nThese files are retried automatically on the next index. Re-run 'tea-rags doctor --quarantine --json' to capture the full list (e.g. to file a GitHub issue).\n`,
  );
}

export interface WorkerSweepDoctorArgs {
  json?: boolean;
  /** Also stop handed-off workers with no progress for `INDEX_WORKER_STALLED_AFTER_MS`. */
  includeStalled?: boolean;
  /** Report what would be stopped; stop and forget nothing. */
  dryRun?: boolean;
}

export interface WorkerSweepDoctorDeps {
  registry: IndexWorkerRegistry;
  probe: IndexWorkerProcessProbe;
  now: () => number;
  platform: NodeJS.Platform;
}

function minutesSince(nowMs: number, thenMs: number): string {
  return `${Math.max(0, Math.round((nowMs - thenMs) / 60_000))}m`;
}

function describeSweptWorker(outcome: IndexWorkerSweepOutcome, nowMs: number): string {
  const { record, verdict, action } = outcome;
  const where = ` · ${record.projectPath}`;
  const why =
    verdict === "stalled"
      ? `no progress for ${minutesSince(nowMs, record.lastProgressAtMs)}`
      : `supervisor ${record.supervisorPid} died before handing it off`;
  switch (action) {
    case "killed":
      return `[KILL] pid ${record.pid} ${verdict} — ${why}; stopped${where}`;
    case "would-kill":
      return `[DRY]  pid ${record.pid} ${verdict} — ${why}; would be stopped${where}`;
    case "kill-failed":
      return `[FAIL] pid ${record.pid} ${verdict} — did not exit after SIGKILL${where}`;
    case "pruned":
      return `[OK]   pid ${record.pid} gone — stale record removed`;
    case "would-prune":
      return `[DRY]  pid ${record.pid} gone — stale record would be removed`;
    case "kept":
      if (verdict === "stalled") {
        return `[WARN] pid ${record.pid} stalled — ${why}; re-run with --include-stalled to stop it${where}`;
      }
      if (verdict === "unverified") {
        return (
          `[WARN] pid ${record.pid} unverified — its start time could not be read, so it cannot be proven to be ` +
          `the worker that registered; kept, record and process${where}`
        );
      }
      if (verdict === "detached") {
        return (
          `[OK]   pid ${record.pid} detached — enriching in the background, ` +
          `last progress ${minutesSince(nowMs, record.lastProgressAtMs)} ago${where}`
        );
      }
      return `[OK]   pid ${record.pid} ${verdict} — supervisor ${record.supervisorPid} is running${where}`;
  }
}

/**
 * `tea-rags doctor --sweep-workers` — stop `index-codebase` workers left behind
 * by a killed foreground CLI (bd tea-rags-mcp-f924y). What may be stopped, and
 * how a pid is proven to be such a worker, is `sweepIndexWorkers`; this renders
 * the outcome. Needs no Qdrant or embeddings, so it works while they are down.
 */
export async function runWorkerSweepDoctor(
  args: WorkerSweepDoctorArgs,
  deps: WorkerSweepDoctorDeps = {
    registry: new IndexWorkerRegistry(indexWorkerRegistryDir(resolveDataDir())),
    probe: psIndexWorkerProcessProbe,
    now: Date.now,
    platform: process.platform,
  },
): Promise<void> {
  if (deps.platform === "win32") {
    const message = "worker sweep is not supported on win32 — there is no ps to prove a pid is an index worker";
    process.stdout.write(
      args.json ? `${JSON.stringify({ error: { code: "UNSUPPORTED_PLATFORM", message } })}\n` : `[WARN] ${message}\n`,
    );
    return;
  }
  const outcomes = await sweepIndexWorkers(deps.registry, deps.probe, {
    now: deps.now,
    killStalled: args.includeStalled === true,
    dryRun: args.dryRun === true,
  });
  const nowMs = deps.now();

  if (args.json) {
    const workers = outcomes.map(({ record, verdict, action }) => ({
      pid: record.pid,
      supervisorPid: record.supervisorPid,
      projectPath: record.projectPath,
      entryScript: record.entryScript,
      verdict,
      action,
      startedAt: new Date(record.startedAtMs).toISOString(),
      lastProgressAt: new Date(record.lastProgressAtMs).toISOString(),
      ...(record.handedOffAtMs !== undefined ? { handedOffAt: new Date(record.handedOffAtMs).toISOString() } : {}),
    }));
    process.stdout.write(`${JSON.stringify({ workers }, null, 2)}\n`);
    return;
  }

  if (outcomes.length === 0) {
    process.stdout.write("No index workers registered.\n");
    return;
  }
  for (const outcome of outcomes) process.stdout.write(`${describeSweptWorker(outcome, nowMs)}\n`);
  const stopped = outcomes.filter((o) => o.action === "killed").length;
  const pruned = outcomes.filter((o) => o.action === "pruned").length;
  process.stdout.write(
    `Swept ${outcomes.length} worker record(s): ${stopped} stopped, ${pruned} stale record(s) removed.\n`,
  );
}

/**
 * Build the same QdrantManager + EmbeddingProvider the MCP server would use.
 * Mirrors the construction path in src/bootstrap/factory.ts:resolveInfrastructure,
 * but skips embedded-daemon spawn (doctor is read-only — connection refused is
 * a legitimate [FAIL] report).
 */
async function defaultDeps(): Promise<DoctorDeps> {
  const { parseAppConfig, getZodConfig } = await import("../../bootstrap/config/index.js");
  const { resolveQdrantUrl } = await import("../../core/api/public/index.js");
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
  command: "doctor [path]",
  describe: "Print infrastructure + registry health summary",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "Project path (for --quarantine; defaults to current directory)",
        default: ".",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Output as JSON",
      })
      .option("recover-registry", {
        type: "boolean",
        default: false,
        describe: "Repopulate the project registry from live Qdrant state",
      })
      .option("quarantine", {
        type: "boolean",
        default: false,
        describe: "List poison-pill files that broke indexing (skipped, retried automatically)",
      })
      .option("sweep-workers", {
        type: "boolean",
        default: false,
        describe:
          "Stop index-codebase workers whose CLI died before handing them off (they keep the collection locked)",
      })
      .option("include-stalled", {
        type: "boolean",
        default: false,
        describe: "With --sweep-workers: also stop handed-off workers with no progress for 30 minutes",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "With --sweep-workers: report what would be stopped without stopping anything",
      })
      .option("restart", {
        type: "boolean",
        default: false,
        describe:
          "Stop ALL live build-keyed codegraph daemons and sweep orphaned key directories; " +
          "every session's next codegraph op cold-spawns its build's daemon again",
      }),
  handler: async (argv) => {
    if (argv.restart) {
      await runDaemonRestartDoctor({ json: argv.json });
      return;
    }
    if (argv["sweep-workers"]) {
      await runWorkerSweepDoctor({
        json: argv.json,
        includeStalled: Boolean(argv["include-stalled"]),
        dryRun: Boolean(argv["dry-run"]),
      });
      return;
    }
    if (argv.quarantine) {
      await runQuarantineDoctor({ path: argv.path ?? ".", json: argv.json });
      return;
    }
    await runDoctor({
      json: argv.json,
      recoverRegistry: Boolean(argv["recover-registry"]),
    });
  },
};
