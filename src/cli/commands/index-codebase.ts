import { fork } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import {
  CollectionRegistry,
  pickRegistryEntry,
  ProjectRegistryOps,
  resolveRegistryEnv,
  TeaRagsError,
  type IndexOptions,
} from "../../core/api/public/index.js";
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
  languages?: string;
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
 * Fork the same CLI binary as a detached worker that runs the actual indexing.
 * `detached` + own process group means the worker survives the foreground's exit
 * (default mode detaches once embeddings finish); `ipc` carries progress back.
 * stdio is otherwise ignored — the foreground owns the terminal and renders —
 * EXCEPT under DEBUG, where the worker's stderr is redirected to a per-run
 * `logs/worker-debug-*.log` so its per-phase timing survives (observability).
 */
function forkWorker(
  path: string,
  options: IndexOptions,
  envOverrides: Record<string, string>,
): ReturnType<typeof fork> {
  const stderrTarget = openWorkerDebugLog();
  const child = fork(process.argv[1], ["index-codebase", "--__worker"], {
    detached: true,
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
        describe: "Force a full re-index from scratch instead of incremental.",
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
      .option("languages", {
        type: "string",
        nargs: 1,
        describe:
          "Restrict the run to these languages — comma-separated (e.g. typescript,ruby). " +
          "With --force-enrichments it narrows the recompute to points of those languages; " +
          "with --force it narrows the WHOLE run, chunking included, which means the rebuilt " +
          "collection contains ONLY them. Not valid on a plain incremental run, whose scope is " +
          "already the set of changed files.",
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
    const forceEnrichments = parseEnrichmentSelectors(argv["force-enrichments"]);
    const languages = parseLanguageSelectors(argv.languages);
    const options: IndexOptions = {
      forceReindex: Boolean(argv.force),
      ...(forceEnrichments ? { forceEnrichments } : {}),
      ...(languages ? { languages } : {}),
    };
    const waitEnrichments = resolveWaitEnrichments(Boolean(argv["wait-enrichments"]), forceEnrichments);
    const jsonMode = Boolean(argv.json);

    const dataDir = resolveDataDir();
    const registry = new CollectionRegistry(dataDir);

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
      registryEnv = resolveRegistryEnv(pickRegistryEntry(registry, { project: argv.project, path }));
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
