import { fork } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import {
  collectionHoldsCodegraphData,
  CollectionRegistry,
  pickRegistryEnvSeed,
  ProjectRegistryOps,
  RESIDUAL_MODELS,
  resolveDomainEnvCodeDefaults,
  resolveRegistryEnv,
} from "../../core/api/index.js";
import { TeaRagsError, type IndexOptions } from "../../core/api/public/index.js";
import { createRenderer } from "../index-progress/renderer.js";
import { superviseIndexing } from "../index-progress/supervisor.js";
import { createColorizer, type Colorizer } from "../infra/color.js";
import { applyProjectDefaults } from "../registry-resolver.js";

export interface IndexCodebaseArgs {
  path?: string;
  project?: string;
  /** Register the resolved path under this alias before indexing (first index of a new project). */
  name?: string;
  "wait-enrichments"?: boolean;
  force?: boolean;
  /** Comma-separated enrichment provider selectors, or `all`. */
  "force-enrichments"?: string;
  /** Model to resolve residual call sites with after codegraph enrichment (`kev`). */
  "resolve-residual"?: string;
  languages?: string;
  /** Scoped force: picomatch pattern of files to re-chunk. */
  "path-pattern"?: string;
  /** Scoped force: `only` / `exclude` test files. */
  "test-file"?: "only" | "exclude";
  /** Scoped force: comma-separated extensions. */
  "file-extension"?: string;
  /** Scoped force: comma-separated project-relative files. */
  files?: string;
  /** `--no-worktree-seed` sets this false: never seed a first index from a sibling working tree. */
  "worktree-seed"?: boolean;
  json?: boolean;
  /** Hidden: marks the forked child as the detached indexing worker. */
  __worker?: boolean;
}

/**
 * Under DEBUG, open a per-run file to receive the detached worker's stderr and
 * return its fd; otherwise return "ignore". The worker's granular per-phase
 * `console.error` DEBUG (e.g. codegraph `CODEGRAPH_NODES_FLUSH`, edge-resolve,
 * SCC/PageRank durations) is otherwise discarded because the foreground owns the
 * terminal and the fork ignores the worker's stdio — leaving the enrichment
 * finalize tail a "dark window" no per-phase split can reach. Best-effort: any
 * IO error falls back to "ignore" so a logging hiccup never blocks indexing.
 */
function openWorkerDebugLog(): number | "ignore" {
  if (process.env.DEBUG !== "true" && process.env.DEBUG !== "1") return "ignore";
  try {
    const logDir = join(resolveDataDir(), "logs");
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return openSync(join(logDir, `worker-debug-${stamp}.log`), "a");
  } catch {
    return "ignore";
  }
}

/**
 * Old-space floor for the index worker, in MB. Node 24's default is ~4096. A
 * large index hit that default (~4GB heap): `JavaScript heap out of memory`,
 * then `worker exited with code null`. 10 GiB is the floor for that process — the
 * one that embeds and hosts blame and the codegraph. The supervisor only
 * renders progress, so it stays on the default heap.
 *
 * A larger `--max-old-space-size` already on the parent `execArgv` or in
 * `NODE_OPTIONS` is kept. A smaller one is raised: the value passed on
 * `execArgv` is what the worker runs with, and a command-line flag overrides
 * `NODE_OPTIONS`.
 */
export const INDEX_WORKER_OLD_SPACE_MB = 10240;

const OLD_SPACE_FLAG = /^(?:--max-old-space-size|--max_old_space_size)(?:=(\d+))?$/;

/** Last positive `--max-old-space-size` in `args`, either `=N` or a following token. */
function readOldSpaceMb(args: readonly string[]): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const match = OLD_SPACE_FLAG.exec(args[i] ?? "");
    if (!match) continue;
    const raw = match[1] ?? args[i + 1];
    if (match[1] === undefined) i++;
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) found = parsed;
  }
  return found;
}

/**
 * `execArgv` for the index-worker `fork`. Replaces the parent's old-space flag
 * (fork does not inherit `execArgv` once this array is set) and leaves every
 * other parent flag in place. Chunker processes forked later inherit this
 * array; `worker_threads` do not — their heaps stay on `resourceLimits`.
 */
export function indexWorkerExecArgv(
  parentExecArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): string[] {
  const nodeOptionArgs = nodeOptions === undefined || nodeOptions.trim() === "" ? [] : nodeOptions.trim().split(/\s+/);
  const fromEnv = readOldSpaceMb(nodeOptionArgs);
  const explicit = Math.max(readOldSpaceMb(parentExecArgv) ?? 0, fromEnv ?? 0);
  const mb = Math.max(explicit, INDEX_WORKER_OLD_SPACE_MB);
  const kept: string[] = [];
  for (let i = 0; i < parentExecArgv.length; i++) {
    const arg = parentExecArgv[i] ?? "";
    const match = OLD_SPACE_FLAG.exec(arg);
    if (!match) {
      kept.push(arg);
      continue;
    }
    if (match[1] === undefined) i++;
  }
  return [...kept, `--max-old-space-size=${String(mb)}`];
}

/**
 * Fork the same CLI binary as a detached worker that runs the actual indexing.
 * `detached` + own process group means the worker survives the foreground's exit
 * (default mode detaches once embeddings finish); `ipc` carries progress back.
 * stdio is otherwise ignored — the foreground owns the terminal and renders —
 * EXCEPT under DEBUG, where the worker's stderr is redirected to a per-run
 * `logs/worker-debug-*.log` so its per-phase timing survives (observability).
 *
 * `execArgv` sets the worker's old space ({@link indexWorkerExecArgv}). The
 * shebang that starts `tea-rags` passes no V8 flag, and `fork` would otherwise
 * copy that empty list — leaving the worker on Node's ~4 GB default.
 */
function forkWorker(
  path: string,
  options: IndexOptions,
  envOverrides: Record<string, string>,
): ReturnType<typeof fork> {
  const stderrTarget = openWorkerDebugLog();
  const child = fork(process.argv[1], ["index-codebase", "--__worker"], {
    detached: true,
    execArgv: indexWorkerExecArgv(),
    stdio: ["ignore", "ignore", stderrTarget, "ipc"],
    // Registry-resolved config seeds the worker env; ambient process.env wins so
    // explicit overrides still take precedence (gap-fill, not override).
    env: { ...envOverrides, ...process.env, TEA_RAGS_INDEX_WORKER: JSON.stringify({ path, options }) },
  });
  // The child inherited its own dup of the log fd at fork; close the parent's
  // copy so the detached worker is its sole owner (the file closes when it exits).
  if (typeof stderrTarget === "number") closeSync(stderrTarget);
  return child;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/**
 * Split the `--force-enrichments` value into provider selectors.
 *
 * The flag takes exactly one argument, so the list travels as a single
 * comma-separated token. Empty entries are dropped; validation of what the
 * selectors actually mean happens in the facade, against the registered
 * providers.
 */
/**
 * Should the CLI stay attached until every provider finishes?
 *
 * A recompute implies it. The flag exists because an ordinary index run returns
 * once embeddings are stored and lets enrichment finish in the background — but
 * a recompute IS the enrichment, so detaching would hand back control before
 * the layer under test has been rebuilt, leaving nothing to measure and no
 * per-provider durations. An empty selector list is not a recompute (the facade
 * rejects it), so it must not turn a plain incremental into a blocking run.
 */
export function resolveWaitEnrichments(waitFlag: boolean, forceEnrichments: string[] | undefined): boolean {
  return waitFlag || (forceEnrichments !== undefined && forceEnrichments.length > 0);
}

export function parseEnrichmentSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split the `--languages` value into language names.
 *
 * Same shape as the enrichment selectors, and deliberately the same
 * "undefined ≠ empty" contract: absent means the whole index, while an empty
 * list is a mistake the facade refuses rather than a silent whole-index run.
 * Which languages are valid is decided there too, against what this build can
 * chunk.
 */
export function parseLanguageSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The run's `IndexOptions`, from the parsed flags. `seedFromWorktree` is set
 * only when `--no-worktree-seed` turned it off, so the core default (seed a first
 * index when a sibling working tree allows it) stays the one source of truth.
 */
export function buildIndexOptions(argv: IndexCodebaseArgs): IndexOptions {
  const forceEnrichments = parseEnrichmentSelectors(argv["force-enrichments"]);
  const languages = parseLanguageSelectors(argv.languages);
  // Same comma-separated, undefined-≠-empty contract as `--languages`; the
  // facade decides what a scope filter may say (bd tea-rags-mcp-j4oww).
  const fileExtensions = parseLanguageSelectors(argv["file-extension"]);
  const files = parseLanguageSelectors(argv.files);
  return {
    forceReindex: Boolean(argv.force),
    ...(forceEnrichments ? { forceEnrichments } : {}),
    ...(argv["resolve-residual"] !== undefined ? { resolveResidual: argv["resolve-residual"] } : {}),
    ...(languages ? { languages } : {}),
    ...(argv["test-file"] !== undefined ? { testFile: argv["test-file"] } : {}),
    ...(argv["path-pattern"] !== undefined ? { pathPattern: argv["path-pattern"] } : {}),
    ...(fileExtensions ? { fileExtensions } : {}),
    ...(files ? { files } : {}),
    ...(argv["worktree-seed"] === false ? { seedFromWorktree: false } : {}),
  };
}

/**
 * Resolve the registered project alias for the given resolved path.
 * Uses `findByPath` for exact path match, then falls back to `get(collectionName)`
 * when collectionName is known. Returns null when no alias is registered.
 */
function resolveProjectName(registry: CollectionRegistry, resolvedPath: string): string | null {
  const entry = registry.findByPath(resolvedPath);
  return entry?.name ?? null;
}

/**
 * Render a typed pre-flight failure and let the handler exit(1) before any
 * worker is forked. Covers both things that can go wrong while setting the run
 * up: registering the alias, and resolving the backend the registry entry
 * addresses. JSON mode emits a parseable { error } object on stdout; text mode
 * writes a colorized one-liner to stderr, followed by the hint — for a stale
 * registry entry the hint IS the fix, so dropping it leaves the operator with
 * nothing to do. Non-typed errors (program bugs) propagate unchanged.
 */
function renderIndexSetupError(err: unknown, opts: { json: boolean; colors: Colorizer }): void {
  if (!(err instanceof TeaRagsError)) throw err;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint } })}\n`);
  } else {
    process.stderr.write(`${opts.colors.alert(`index-codebase: ${err.message}`)}\n`);
    process.stderr.write(`${opts.colors.dim(err.hint)}\n`);
  }
}

export const indexCodebaseCommand: CommandModule<object, IndexCodebaseArgs> = {
  command: "index-codebase [path]",
  describe: "Index a codebase with live embedding + per-provider enrichment progress.",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "Project path to index. Optional if --project is given (defaults to cwd).",
      })
      .option("project", {
        type: "string",
        describe: "Project alias from the registry. Resolves --path from the registered entry.",
      })
      .option("name", {
        type: "string",
        describe:
          "Register the path under <alias> in the project registry, then index. Use for the first index of a new project.",
      })
      .conflicts("name", "project")
      .option("wait-enrichments", {
        type: "boolean",
        default: false,
        describe:
          "Stay until every enrichment provider finishes (full per-provider bars). Default: detach after embeddings with an ETA.",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe:
          "Force a full re-index from scratch into a new collection (zero downtime, alias swaps at the end). " +
          "With any of --languages, --test-file, --path-pattern, --file-extension or --files it is a SCOPED " +
          "force instead: only the selected indexed files are re-chunked and re-embedded, in place on the live " +
          "collection, and every other point stays as it is.",
      })
      .option("force-enrichments", {
        type: "string",
        nargs: 1,
        describe:
          "Rebuild the enrichment layer across the WHOLE index without re-embedding. " +
          "Syncs the working tree incrementally first, then recomputes the selected providers. " +
          "Value is required — comma-separated provider keys or `all` " +
          "(e.g. all, git, codegraph, codegraph.symbols). " +
          "Use this to validate a new signal, walker, or resolver; use --force only when " +
          "chunking, parsing, or the vectors themselves changed. Implies --wait-enrichments: " +
          "the recompute IS the enrichment, so detaching would return before it finished.",
      })
      .option("resolve-residual", {
        type: "string",
        nargs: 1,
        choices: RESIDUAL_MODELS,
        describe:
          "After codegraph enrichment, ask this model about the call sites static resolution left " +
          "ambiguous or dynamic, and add its confident answers as model edges. Verdicts are cached " +
          "across runs, and later runs without the flag re-apply them with no model call. Needs " +
          "CODEGRAPH_RESIDUAL_KEV_URL. An unreachable model skips the pass; indexing still succeeds.",
      })
      .option("languages", {
        type: "string",
        nargs: 1,
        describe:
          "Restrict the run to these languages — comma-separated (e.g. typescript,ruby). " +
          "With --force-enrichments it narrows the recompute to points of those languages; " +
          "with --force it re-chunks the files of those languages in place (a scoped force) and " +
          "leaves every other language's points untouched. Not valid on a plain incremental run, " +
          "whose scope is already the set of changed files.",
      })
      .option("test-file", {
        type: "string",
        choices: ["only", "exclude"] as const,
        describe:
          "Scoped --force: re-chunk only test files (only) or everything but them (exclude), by the same " +
          "classification as the search testFile filter.",
      })
      .option("path-pattern", {
        type: "string",
        nargs: 1,
        describe:
          "Scoped --force: re-chunk indexed files matching this picomatch pattern (leading ! negates), " +
          "e.g. 'spec/**'. Same matcher as the search pathPattern.",
      })
      .option("file-extension", {
        type: "string",
        nargs: 1,
        describe: "Scoped --force: re-chunk files with these extensions, comma-separated (e.g. .rb,.rake).",
      })
      .option("files", {
        type: "string",
        nargs: 1,
        describe: "Scoped --force: re-chunk exactly these project-relative files, comma-separated.",
      })
      .option("worktree-seed", {
        type: "boolean",
        default: true,
        describe:
          "First index only: when another working tree of the same git repository is already indexed " +
          "with the same model and settings, clone its index and embed only the files that differ. " +
          "Pass --no-worktree-seed to index from scratch.",
      })
      // NOT `.conflicts()`: `--force` declares `default: false`, and yargs
      // treats a key carrying a default as PRESENT, so `.conflicts()` rejected
      // every `--force-enrichments` run even when `--force` was never typed.
      // Checking the values directly is the only form that distinguishes
      // "defaulted" from "passed".
      .check((argv) => {
        if (argv.force === true && argv["force-enrichments"] !== undefined) {
          throw new Error("Arguments force and force-enrichments are mutually exclusive");
        }
        return true;
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe:
          "Emit a single JSON object to stdout at finish instead of human-readable output. Intended for agent/script consumers.",
      })
      .option("__worker", { type: "boolean", default: false, hidden: true }),
  handler: async (argv) => {
    // Forked child path: run the worker entry, not another supervisor.
    if (argv.__worker) {
      const { main } = await import("../index-progress/worker.js");
      await main();
      return;
    }

    const resolved = applyProjectDefaults(argv);
    const path = resolve(resolved.path ?? process.cwd());
    const options = buildIndexOptions(argv);
    const waitEnrichments = resolveWaitEnrichments(Boolean(argv["wait-enrichments"]), options.forceEnrichments);
    const jsonMode = Boolean(argv.json);

    const dataDir = resolveDataDir();
    const registry = new CollectionRegistry(dataDir, {
      envCodeDefaults: () => resolveRegistryEnvCodeDefaults(resolveDomainEnvCodeDefaults()),
      codegraphDataProbe: collectionHoldsCodegraphData,
    });

    // JSON mode forces NO_COLOR semantics so the output is clean for parsing.
    const colors = createColorizer(jsonMode ? { env: { NO_COLOR: "1" }, isTTY: false } : undefined);

    // Seed the worker's embedding / codegraph config from the registry (the
    // named project, this path's entry, or — for a new project — the most
    // recently indexed one) so the operator need not re-export EMBEDDING_* envs.
    // An entry whose backend cannot be resolved stops the run HERE: forking on
    // an unresolved backend only defers the failure to the worker, where it
    // resurfaces as a bare "Qdrant is not reachable at <dead port>".
    let registryEnv: Record<string, string>;
    try {
      registryEnv = resolveRegistryEnv(pickRegistryEnvSeed(registry, { project: argv.project, path }));
    } catch (err) {
      renderIndexSetupError(err, { json: jsonMode, colors });
      process.exit(1);
    }

    // --name: register this path under the alias BEFORE indexing so a new
    // project gets its alias in one command. Env is already resolved above, so
    // the fresh stub entry does not shadow the most-recently-indexed embedding
    // fallback. No qdrant in deps — the collection does not exist yet. A typed
    // failure renders and exits before any worker is forked.
    if (argv.name) {
      try {
        await new ProjectRegistryOps({ registry }).register({ path, name: argv.name });
      } catch (err) {
        renderIndexSetupError(err, { json: jsonMode, colors });
        process.exit(1);
      }
    }

    // Resolve the registered project alias for the status block.
    const projectName = argv.name ?? argv.project ?? resolveProjectName(registry, path) ?? undefined;

    const renderer = createRenderer({ isTTY: Boolean(process.stderr.isTTY), colors, json: jsonMode });
    const child = forkWorker(path, options, registryEnv);

    const code = await superviseIndexing(child, {
      renderer,
      waitEnrichments,
      colors,
      out: (line) => process.stdout.write(`${line}\n`),
      now: () => Date.now(),
      projectName,
      path,
    });

    // Detached + own process group: exiting the foreground here leaves the worker
    // running to finish enrichment in default mode. In --wait mode the worker has
    // already emitted `done`, so exiting is clean.
    process.exit(code);
  },
};
