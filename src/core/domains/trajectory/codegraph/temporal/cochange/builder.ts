/**
 * `TemporalCochangeBuilder` — rebuilds `cg_temporal_*` at codegraph collection
 * completion (bd tea-rags-mcp-x4rpp).
 *
 * history (discovery matrix, windowed) → scope to the project's HEAD paths →
 * bundle (per commit, or per author session) → adaptive mass-change cut →
 * association rules with the storage cap → one wholesale snapshot.
 *
 * Every incremental index finalizes, so the build is gated on the provenance
 * row: same HEAD, same parameter fingerprint and built within a day ⇒ skipped
 * without touching history. The day bound exists because the window slides with
 * the clock while HEAD stands still. A moved HEAD reads history through the SAME
 * persisted discovery store the git trajectory's chunk walk fills, with the same
 * window (`chunkMaxAgeMonths`), so on a warm index the log is a snapshot load,
 * not a `git log` — and the two consumers never overwrite each other's snapshot
 * with a different window.
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { VcsAdapterFactory } from "../../../../../adapters/vcs/factory.js";
import { resolveRepoRoot } from "../../../../../adapters/vcs/git/git-cli/client.js";
import type { GitAdapterKind } from "../../../../../adapters/vcs/types.js";
import type { RelPath, TemporalCochangeBuildMeta } from "../../../../../contracts/types/codegraph.js";
import { GitCommitDiscovery, GitCommitDiscoveryStore, type GitCommitDiscoveryEntry } from "../../../git/index.js";
import type {
  CodegraphCollectionCompletionContext,
  CodegraphCollectionCompletionHook,
} from "../../collection-completion-hook.js";
import { bundleCochangeCommits } from "./commit-bundles.js";
import { scopeCochangeHistory } from "./history-scope.js";
import { computeMassChangeCut, MASS_CHANGE_CEILING } from "./mass-change-cut.js";
import { extractCochangeGraph } from "./pair-extractor.js";

/**
 * Pairs seen fewer times are not stored. Two is the definitional minimum of a
 * REPEATED co-change, not a tuned value — the 9szed gate measured the next
 * step up (support ≥ 5) cutting recall from 27.57% to 17.96%.
 */
export const TEMPORAL_COCHANGE_MIN_SUPPORT = 2;

/**
 * Per-file storage cap (spec open question 2). A storage bound, not a
 * judgement: an edge survives when it ranks in the top N of EITHER endpoint, and
 * the report's "strong" cut is adaptive over what is stored.
 */
export const TEMPORAL_COCHANGE_MAX_PARTNERS_PER_FILE = 20;

/** Bump when the extraction semantics change, so every stored graph rebuilds. */
const COCHANGE_ALGORITHM_REVISION = 1;

/** The git trajectory's `chunkTimeoutMs` default. */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

const DAY_SECONDS = 86_400;
/** The discovery window formula (`GitCommitDiscovery#buildMatrix`): months of 30 days. */
const MONTH_SECONDS = 30 * DAY_SECONDS;

/** One repository's history as the builder reads it. */
export interface TemporalCochangeHistory {
  repoRoot: string;
  head: string;
  /** Discovery rows, newest → oldest, inside the window. Only read when a rebuild is due. */
  entries: () => Promise<readonly GitCommitDiscoveryEntry[]>;
}

/** Opens a project's history; the default reads git through the discovery matrix. */
export interface TemporalCochangeHistorySource {
  open: (projectRoot: string) => Promise<TemporalCochangeHistory>;
}

export interface TemporalCochangeBuilderOptions {
  /** History window in months — the git trajectory's `chunkMaxAgeMonths`. */
  windowMonths: number;
  /** Author-session gap bundling commits; `null` = one bundle per commit. */
  sessionGapMinutes: number | null;
  /** `GIT_ADAPTER` for the default git history source; default `"git"` (the CLI). */
  vcsAdapter?: GitAdapterKind;
  /** Inactivity timeout for the default source's `git log`; the git trajectory's `chunkTimeoutMs`. */
  gitTimeoutMs?: number;
  /** Overrides the git history source (tests, offline harnesses). */
  historySource?: TemporalCochangeHistorySource;
  /** Whether an ABSOLUTE path exists; default `existsSync`. */
  fileExists?: (absolutePath: string) => boolean;
  /** Clock in ms; default `Date.now`. */
  now?: () => number;
}

export type TemporalCochangeBuildOutcome =
  | { status: "fresh"; meta: TemporalCochangeBuildMeta }
  | { status: "built"; meta: TemporalCochangeBuildMeta; fileCount: number; edgeCount: number };

/** Reads git history through the discovery matrix and its persisted store. */
export class GitTemporalCochangeHistorySource implements TemporalCochangeHistorySource {
  constructor(private readonly options: { vcsAdapter: GitAdapterKind; windowMonths: number; timeoutMs: number }) {}

  async open(projectRoot: string): Promise<TemporalCochangeHistory> {
    const repoRoot = resolveRepoRoot(projectRoot);
    const adapter = await VcsAdapterFactory.create(this.options.vcsAdapter, repoRoot);
    const head = await adapter.getHead();
    return {
      repoRoot,
      head,
      entries: async () =>
        new GitCommitDiscovery(adapter, {
          maxAgeMonths: this.options.windowMonths,
          timeoutMs: this.options.timeoutMs,
          store: new GitCommitDiscoveryStore(),
        }).allEntries(),
    };
  }
}

export class TemporalCochangeBuilder implements CodegraphCollectionCompletionHook {
  readonly name = "temporal-cochange";
  private readonly historySource: TemporalCochangeHistorySource;
  private readonly fileExists: (absolutePath: string) => boolean;
  private readonly now: () => number;

  constructor(private readonly options: TemporalCochangeBuilderOptions) {
    this.historySource =
      options.historySource ??
      new GitTemporalCochangeHistorySource({
        vcsAdapter: options.vcsAdapter ?? "git",
        windowMonths: options.windowMonths,
        timeoutMs: options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      });
    this.fileExists = options.fileExists ?? existsSync;
    this.now = options.now ?? Date.now;
  }

  async onCollectionComplete({
    projectRoot,
    graphDb,
  }: CodegraphCollectionCompletionContext): Promise<TemporalCochangeBuildOutcome> {
    const history = await this.historySource.open(projectRoot);
    const fingerprint = this.fingerprint();
    const nowSeconds = Math.floor(this.now() / 1000);
    const previous = await graphDb.readTemporalCochangeMeta();
    if (
      previous?.head === history.head &&
      previous.fingerprint === fingerprint &&
      nowSeconds - previous.builtAt < DAY_SECONDS
    ) {
      return { status: "fresh", meta: previous };
    }

    const projectPrefix = projectPrefixOf(history.repoRoot, projectRoot);
    const commits = scopeCochangeHistory(await history.entries(), {
      projectPrefix,
      fileExists: (relPath: RelPath) => this.fileExists(join(projectRoot, relPath)),
    });
    const bundles = bundleCochangeCommits(commits, this.options.sessionGapMinutes);
    const maxFilesPerBundle = computeMassChangeCut(bundles.map((b) => b.files.length));
    const graph = extractCochangeGraph(bundles, {
      minSupport: TEMPORAL_COCHANGE_MIN_SUPPORT,
      maxPartnersPerFile: TEMPORAL_COCHANGE_MAX_PARTNERS_PER_FILE,
      maxFilesPerBundle,
    });
    const meta: TemporalCochangeBuildMeta = {
      head: history.head,
      fingerprint,
      builtAt: nowSeconds,
      windowSince: nowSeconds - this.options.windowMonths * MONTH_SECONDS,
      commitCount: commits.length,
      bundleCount: bundles.length,
      admittedBundleCount: graph.admittedBundleCount,
      maxFilesPerBundle,
      minSupport: TEMPORAL_COCHANGE_MIN_SUPPORT,
      maxPartnersPerFile: TEMPORAL_COCHANGE_MAX_PARTNERS_PER_FILE,
      sessionGapMinutes: this.options.sessionGapMinutes,
    };
    await graphDb.replaceTemporalCochange({ meta, files: graph.files, edges: graph.edges });
    return { status: "built", meta, fileCount: graph.files.length, edgeCount: graph.edges.length };
  }

  /** Every parameter that shapes the stored graph — a change to any one rebuilds it. */
  private fingerprint(): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          revision: COCHANGE_ALGORITHM_REVISION,
          windowMonths: this.options.windowMonths,
          sessionGapMinutes: this.options.sessionGapMinutes,
          minSupport: TEMPORAL_COCHANGE_MIN_SUPPORT,
          maxPartnersPerFile: TEMPORAL_COCHANGE_MAX_PARTNERS_PER_FILE,
          massChangeCeiling: MASS_CHANGE_CEILING,
        }),
      )
      .digest("hex")
      .slice(0, 16);
  }
}

/**
 * `projectRoot` relative to `repoRoot` as a POSIX prefix with a trailing `/`,
 * `""` when they coincide. Both sides are realpath'd so a symlinked checkout
 * (macOS `/var` → `/private/var`) still lines up.
 */
function projectPrefixOf(repoRoot: string, projectRoot: string): string {
  const rel = relative(realpathOr(repoRoot), realpathOr(projectRoot));
  if (rel === "" || rel.startsWith("..")) return "";
  return `${rel.split(sep).join("/")}/`;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
