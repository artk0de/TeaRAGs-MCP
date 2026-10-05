/**
 * codegraph-chain-tally.ts (bd tea-rags-mcp-86qfb)
 *
 * What the resolution chain EMITTED over a real corpus, for a language that has
 * no type-checker oracle. `scripts/ts-codegraph-typechecker-oracle.ts` grew a
 * `CHAIN OUTPUT` block for exactly this reason (bd 5onmn): verdict tables only
 * cover call sites the oracle has an opinion about, and a change that trades
 * edges for precision inside the blind spots is invisible in them. Python and
 * Java have no oracle at all, so the tally IS the measurement.
 *
 * Three modes:
 *
 *   - default — walk the corpus, run the production chain, report
 *     `edges` / `fileOnly` / `unresolved`.
 *   - `--defer <passName>` — ALSO run a second chain, identical except that the
 *     named pass's file-only commit (`resolved({ targetSymbolId: null })`) is
 *     converted to a `deferred` park, and diff the two per call site.
 *   - `--time-only` (E6.0a) — skip the rebuilt chain entirely and resolve every
 *     site through the production resolver, so a language with no `ChainSpec`
 *     can still be walked and TIMED. This is what makes the E6 comparison
 *     possible at all: ruby and typescript get their wall and their peak RSS
 *     from the SAME walk implementation python's come from, which is the only
 *     way the three numbers are comparable. It buys that by giving up the
 *     drift check — `chainDrift` is structurally 0 and the report says so.
 *
 * The A/B runs in ONE process over ONE symbol table, so the two sides differ by
 * exactly the swapped slot — no baseline drift, no "revert src/ and re-run"
 * ritual. The deferred chain is REBUILT from the same exported strategy classes
 * the production resolver composes (the precedent is the DROP-surface oracle in
 * `taxdome-codegraph-recall-forensics.ts`), and every call site cross-checks the
 * rebuilt baseline against the real `LanguageProvider.resolver` — a non-zero
 * `chainDrift` means the rebuild no longer mirrors production and the numbers
 * are void.
 *
 * The diff buckets are the decision. A park can only be beaten by a LATER pass
 * returning `resolved`, so each changed call site lands in one of:
 *
 *   - `upgradedSameFile`  — park replaced by a symbol IN the parked file. The
 *     shape deferral is FOR.
 *   - `relocatedOtherFile` — park replaced by a symbol in a DIFFERENT file. The
 *     edge's file attribution moved, which is what `fanIn` / `fanOut` /
 *     PageRank read.
 *   - `lost` / `gained` — an edge disappeared or appeared. Invariant 3 says
 *     `lost` must be 0.
 *
 * `--kind-stats` is orthogonal to the three: it recomputes the per-receiver-kind
 * counters `cg_run_stats` persists — folding the production runner's own per-site
 * verdict (`CallEdgeResolutionRunner#callSiteVerdicts`) with its own
 * `tallyCallSiteVerdict`, dispatch-table sites and the `dispatchArgs` join
 * included — so a DENOMINATOR change is measurable without a reindex, next to
 * the edge counts that must not move (bd tea-rags-mcp-1v12o.3 / c6xuu).
 *
 * Usage:
 *   npx tsx scripts/codegraph-chain-tally.ts --corpus <abs path> --lang python \
 *     [--defer globalShortName] [--limit N] [--samples 10] [--json out.json] \
 *     [--kind-stats] [--persisted]
 *
 *   env -u NODE_OPTIONS npx tsx scripts/codegraph-chain-tally.ts \
 *     --corpus <abs path> --lang ruby --quiet --time-only [--ts-checker=off]
 *
 * `env -u NODE_OPTIONS` is not decoration: this machine carries a fish universal
 * `--max_old_space_size=8192`, and a process-wide heap ceiling silently
 * overrides the per-worker one, so three languages measured under it get three
 * different effective ceilings.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve as resolvePath, sep } from "node:path";

import { deferred } from "../src/core/contracts/resolution.js";
import { formatResolveRateCell, resolveRateMiss } from "../src/core/contracts/resolve-rate.js";
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type FileExtraction,
  type GraphEdges,
  type SymbolResolutionTarget,
} from "../src/core/contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../src/core/contracts/types/language.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import {
  JavaEnclosingBareCallSymbolResolutionStrategy,
  JavaFieldTypeSymbolResolutionStrategy,
  JavaGlobalShortNameSymbolResolutionStrategy,
  JavaImportReceiverSymbolResolutionStrategy,
  JavaLocalBindingSymbolResolutionStrategy,
  JavaThisMemberSymbolResolutionStrategy,
} from "../src/core/domains/language/java/resolver/strategies/index.js";
import { dispatchFanoutPolicyFor } from "../src/core/domains/language/kernel/fanout-policy.js";
import { resolveViaChain } from "../src/core/domains/language/kernel/index.js";
import {
  createPythonSymbolResolutionChain,
  PythonAncestorLinearizerCache,
  PythonImportFileMapper,
} from "../src/core/domains/language/python/resolver/index.js";
import { CONE_MAX_DEFAULT } from "../src/core/domains/language/python/resolver/strategies/index.js";
import {
  collectSchemaColumnSources,
  collectStructuralConformanceDerivers,
} from "../src/core/domains/trajectory/codegraph/exclusion.js";
import { absorbPass1FileState } from "../src/core/domains/trajectory/codegraph/symbols/extraction-sink.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { RECEIVER_KINDS, type ReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import {
  CallEdgeResolutionRunner,
  tallyCallSiteVerdict,
  type CallSiteVerdict,
} from "../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import {
  CodegraphRunState,
  emptyReceiverKindTally,
  type ReceiverKindTally,
} from "../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectDependencyManifestSources } from "../src/core/infra/dependency-manifests.js";
import { NO_FAN, scoreFan, type PyFanOutcomeKind } from "./lib/py-oracle-core.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
} from "./ts-codegraph-typechecker-oracle.js";

// ---------------------------------------------------------------------------
// Per-language chain rebuild — the production order, verbatim.
// ---------------------------------------------------------------------------

/** The chain a language's `CallResolver` composes, plus the extensions it owns. */
interface ChainSpec {
  /**
   * Extensions whose CALL SITES are scored. Narrower than the walk: every
   * language feeds the symbol table, but only this resolver's own files are
   * diffed, or the tally would report one resolver's verdict on another's corpus.
   */
  extensions: readonly string[];
  build: () => SymbolResolutionStrategy[];
  /** One extra headline line this language's chain can account for, after the run. */
  report?: () => string;
}

const MODE = DEFAULT_AMBIGUOUS_RESOLVE_MODE;

/**
 * The ONE ancestor-linearizer cache the Python chain uses, held here so the
 * gate can read its fallback counter once the walk is over. `PythonCallResolver`
 * owns one instance for the same reason (bd tea-rags-mcp-9fgdi, decision 7).
 */
const pythonMapper = new PythonImportFileMapper();
const pythonLinearizers = new PythonAncestorLinearizerCache(pythonMapper, MODE);

const CHAINS: Record<string, ChainSpec> = {
  // The production factory itself, not a copy of it (bd tea-rags-mcp-3yxmy).
  // The factory allocates its own import-file mapper per chain, which is the
  // per-chain sharing `PythonCallResolver` gives its single instance.
  python: {
    extensions: [".py"],
    build: () =>
      createPythonSymbolResolutionChain({ mode: MODE, coneMax: CONE_MAX_DEFAULT }, pythonMapper, pythonLinearizers),
    // How often C3 gave up and the left-to-right DFS fallback produced an order
    // (bd tea-rags-mcp-9fgdi, decision 4). A silent fallback is an unmeasured
    // order, so the gate prints it. The cache is hoisted out of `build` because
    // it is what holds the counter; the chain it feeds is the production one.
    report: () => `  C3 linearization fallbacks: ${pythonLinearizers.linearizationFallbacks}`,
  },
  // Mirrors `JavaCallResolver`'s array (java-resolver.ts).
  java: {
    extensions: [".java"],
    build: () => {
      const cfg = { mode: MODE };
      return [
        new JavaThisMemberSymbolResolutionStrategy(cfg),
        new JavaFieldTypeSymbolResolutionStrategy(cfg),
        new JavaLocalBindingSymbolResolutionStrategy(cfg),
        new JavaImportReceiverSymbolResolutionStrategy(cfg),
        new JavaEnclosingBareCallSymbolResolutionStrategy(cfg),
        new JavaGlobalShortNameSymbolResolutionStrategy(cfg),
      ];
    },
  },
};

/**
 * Extensions whose call sites this language's resolver owns, inverted out of
 * the engine's own extension→language map rather than hand-listed. `.tsx` is
 * why: a hand-list that forgets it silently scores half a TypeScript corpus and
 * reports the wall as if it walked all of it. The map also settles which leg
 * `.js`/`.jsx` belong to — `javascript`, not `typescript` — so the TypeScript
 * leg is `.ts`/`.tsx`/`.mts`/`.cts` and JavaScript gets a leg of its own for free.
 */
export function scoredExtensionsFor(lang: string): readonly string[] {
  const exts = Object.entries(CODEGRAPH_LANGUAGES)
    .filter(([, cfg]) => cfg.language === lang)
    .map(([ext]) => ext);
  if (exts.length === 0) throw new Error(`language '${lang}' has no walkable extension`);
  return exts;
}

/** Wall/heap accounting for one tally run. Present only under `--timing`. */
export interface ChainTallyTiming {
  /** Walk + extract + symbol table + type channels, ms. */
  pass1Ms: number;
  /** Resolve every call site, ms. Excludes the LOC count and the report. */
  pass2Ms: number;
  /** `pass1Ms + pass2Ms`. NOT the process wall — `tsx` startup is excluded. */
  totalMs: number;
  /** Max `process.memoryUsage().rss` seen by a 250 ms in-process sampler, MB. */
  peakRssMb: number;
  /** Lines in the SCORED files, counted after pass 2 so it cannot pollute either. */
  loc: number;
}

/**
 * Peak `rss` over the run, sampled rather than read at the end: V8 releases
 * pages back before a run finishes, so a single end-of-run reading under-reports
 * the peak by the whole symbol table on a large corpus. 250 ms is the interval
 * `scripts/spikes/rss-tree-sampler.sh` uses at the live level, so the two
 * levels' numbers mean the same thing and carry the same blind spot — a spike
 * shorter than a quarter second. `unref` so the timer cannot hold the process
 * open.
 */
export function startRssSampler(): { stop: () => number } {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const { rss } = process.memoryUsage();
    if (rss > peak) peak = rss;
  }, 250);
  timer.unref();
  return {
    stop: (): number => {
      clearInterval(timer);
      return Math.round(Math.max(peak, process.memoryUsage().rss) / 1024 / 1024);
    },
  };
}

/**
 * The `--timing` block, as its own function because the four normalized columns
 * ARE the E6 verdict: a per-1k divisor applied to the wrong unit turns a 2×
 * regression into a pass, and that arithmetic deserves a unit test rather than
 * an eyeball over a run. Divisors guard against an empty corpus — `0 sites`
 * must print `n/a`, never `Infinity`, or a leg that walked nothing reads as
 * infinitely fast.
 */
export function formatTimingBlock(
  timing: ChainTallyTiming,
  run: { files: number; sites: number; timeOnly: boolean },
): string[] {
  const secs = timing.totalMs / 1000;
  const per = (numerator: number, denominator: number, digits: number): string =>
    denominator === 0 ? "n/a" : (numerator / denominator).toFixed(digits);
  const lines = [
    "",
    "TIMING (harness-internal; excludes tsx startup)",
    `  pass1 ${(timing.pass1Ms / 1000).toFixed(2)}s · pass2 ${(timing.pass2Ms / 1000).toFixed(2)}s` +
      ` · total ${secs.toFixed(2)}s · peak RSS ${timing.peakRssMb} MB`,
    `  ${run.files} scored files · ${run.sites} sites · ${timing.loc} LOC`,
    `  normalized: ${per(secs, run.sites / 1000, 3)} s/1k sites · ${per(run.sites, secs, 0)} sites/s` +
      ` · ${per(secs, timing.loc / 10000, 3)} s/10k LOC · ${per(timing.peakRssMb, run.files / 1000, 0)} MB/1k files`,
  ];
  if (run.timeOnly) lines.push("  --time-only: production resolver only, chain-drift check NOT run");
  return lines;
}

/**
 * Wrap one pass so its FILE-ONLY commit becomes a park. Every other outcome —
 * a pinned `resolved`, a `drop`, a `continue` — passes through untouched, so the
 * A side and the B side differ by exactly the one branch under test.
 */
class DeferFileOnlyStrategy implements SymbolResolutionStrategy {
  readonly name: string;
  constructor(private readonly inner: SymbolResolutionStrategy) {
    this.name = inner.name;
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const outcome = this.inner.attempt(call, ctx);
    if (outcome.kind === "resolved" && outcome.target.targetSymbolId === null) return deferred(outcome.target);
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Tally + diff — pure, so the shape of the answer is inspectable.
// ---------------------------------------------------------------------------

export interface ChainOutputTally {
  /** Call sites the chain resolved to anything. */
  edges: number;
  /** Of those, edges with `targetSymbolId === null` — a SUBSET of `edges`. */
  fileOnly: number;
  /** Call sites the chain declined. */
  unresolved: number;
}

export interface CallSiteRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  baseline: SymbolResolutionTarget | null;
  variant: SymbolResolutionTarget | null;
  /**
   * Whether the baseline's target names a file that actually exists in the
   * corpus. Both import mappers (`mapPythonImportToFile`, `mapJavaImportToFile`)
   * synthesise a path from the import text WITHOUT probing disk, so an external
   * import yields a phantom path (`java/util/Objects.java`, `re.py`). A file-only
   * edge on a phantom path is the resolver's de-facto "this call leaves the
   * project" marker, and replacing it with an in-project symbol FABRICATES an
   * edge rather than upgrading one. Nothing else in the diff distinguishes the
   * two cases, and they point opposite ways.
   */
  baselineTargetInProject: boolean;
  /**
   * What the dispatch layer emitted here (bd tea-rags-mcp-w205u, E4.0.3).
   * `none` under `--no-dispatch`, where the layer was never consulted.
   */
  dispatchOutcome: PyFanOutcomeKind;
  /** `fan.length` for `single` / `fan`, `candidateCount` for `ambiguous`, 0 for `none`. */
  fanSize: number;
  /**
   * A dispatch-table site (`CallRef.dispatch`). Production never runs the exact
   * chain on it, so `baseline` / `variant` are null and the chain A/B skips it;
   * `runnerEdges` and the kind stats still carry what production books there.
   */
  dispatchTable: boolean;
  /**
   * Every method edge PRODUCTION pushes for this site, straight off the runner's
   * verdict (bd tea-rags-mcp-c6xuu): a dispatch-table fan, the additive
   * `dispatchArgs` join (callee edge plus callee-sourced fan), a cone — all of it.
   */
  runnerEdges: MethodEdge[];
  /**
   * The answer PRODUCTION books when it is a single 1:1 edge — `runnerEdges`'
   * only target — and null where a fan, a join, an over-cap decision or a
   * decline left it none. `baseline` deliberately stays the EXACT chain — the
   * A/B this script exists for is a chain instrument, and folding a fan into it
   * would make a real drift invisible (Step 7).
   */
  runnerAnswer: SymbolResolutionTarget | null;
}

type MethodEdge = GraphEdges["methodEdges"][number];

/** {@link CallSiteRow.runnerAnswer} off the runner's verdict. */
function runnerAnswerOf(verdict: CallSiteVerdict): SymbolResolutionTarget | null {
  if (verdict.edges.length !== 1) return null;
  const [{ targetRelPath, targetSymbolId }] = verdict.edges;
  return { targetRelPath, targetSymbolId };
}

export interface DiffTally {
  /** Baseline emitted a file-only edge; the variant pinned a symbol in the SAME file. */
  upgradedSameFile: number;
  /** Baseline emitted a file-only edge; the variant pinned a symbol in a DIFFERENT file. */
  relocatedOtherFile: number;
  /** Of `relocatedOtherFile`, those whose baseline file EXISTS in the corpus. */
  relocatedFromInProject: number;
  /** Of `relocatedOtherFile`, those whose baseline file was a phantom external path. */
  relocatedFromExternal: number;
  /** Baseline emitted an edge; the variant emitted none. Invariant 3 says this is 0. */
  lost: number;
  /** Baseline emitted no edge; the variant emitted one. */
  gained: number;
  /** Any other movement (pinned → pinned elsewhere, file-only → file-only elsewhere). */
  other: number;
}

export function tallyChainOutput(targets: readonly (SymbolResolutionTarget | null)[]): ChainOutputTally {
  const tally: ChainOutputTally = { edges: 0, fileOnly: 0, unresolved: 0 };
  for (const target of targets) {
    if (target === null) {
      tally.unresolved++;
      continue;
    }
    tally.edges++;
    if (target.targetSymbolId === null) tally.fileOnly++;
  }
  return tally;
}

/**
 * Baseline edges whose `targetRelPath` names no file of the corpus — the
 * phantom external targets of bd tea-rags-mcp-vfmfg. `fileOnly` picks the
 * `targetSymbolId === null` half, else the symbol-bearing half.
 */
export function countPhantomTargets(rows: readonly CallSiteRow[], fileOnly: boolean): number {
  return rows.filter(
    (r) => r.baseline !== null && !r.baselineTargetInProject && (r.baseline.targetSymbolId === null) === fileOnly,
  ).length;
}

/** Same target? Both null, or both naming the same file and the same symbol. */
export function sameTarget(a: SymbolResolutionTarget | null, b: SymbolResolutionTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.targetRelPath === b.targetRelPath && a.targetSymbolId === b.targetSymbolId;
}

export function diffRows(rows: readonly CallSiteRow[]): { tally: DiffTally; changed: CallSiteRow[] } {
  const tally: DiffTally = {
    upgradedSameFile: 0,
    relocatedOtherFile: 0,
    relocatedFromInProject: 0,
    relocatedFromExternal: 0,
    lost: 0,
    gained: 0,
    other: 0,
  };
  const changed: CallSiteRow[] = [];
  for (const row of rows) {
    if (sameTarget(row.baseline, row.variant)) continue;
    changed.push(row);
    const { baseline, variant } = row;
    if (baseline !== null && variant === null) tally.lost++;
    else if (baseline === null && variant !== null) tally.gained++;
    else if (
      baseline !== null &&
      variant !== null &&
      baseline.targetSymbolId === null &&
      variant.targetSymbolId !== null
    ) {
      if (baseline.targetRelPath === variant.targetRelPath) tally.upgradedSameFile++;
      else {
        tally.relocatedOtherFile++;
        if (row.baselineTargetInProject) tally.relocatedFromInProject++;
        else tally.relocatedFromExternal++;
      }
    } else tally.other++;
  }
  return { tally, changed };
}

// ---------------------------------------------------------------------------
// Corpus walk — the oracle's, verbatim (bd tea-rags-mcp-q6ber).
// ---------------------------------------------------------------------------

/**
 * Every extension production builds a codegraph node for, so the symbol table
 * this harness hands the chain is the run-global one production builds rather
 * than a single-language slice of it.
 *
 * The two halves of corpus parity are separable and both were wrong here. The
 * WALK used a hand-rolled skip list and read no ignore file, so it scored files
 * production never indexes — on ugnest, 20 of them (19 under `domains/media`,
 * dropped by the repo's `.dockerignore`/`.contextignore`, plus a root
 * `conftest.py`). The TABLE held only `--lang`'s extension, so a Python call
 * into a TypeScript definition found no node to pin and the chain reported an
 * absence production does not have; on polar that is 1,756 extra files, and the
 * definitions they carry push short names past the cone limit. Importing the
 * oracle's own walk fixes both at once and keeps the two harnesses reading the
 * same corpus, which is the only way their `chainOutput` triples can be
 * compared (bd tea-rags-mcp-wl0e6).
 */
const SYMBOL_TABLE_EXTENSIONS: readonly string[] = Object.keys(CODEGRAPH_LANGUAGES);

/**
 * A run state wired as the provider wires it: the constructor's two
 * language-contributed source vocabularies, then the run-start seam — project
 * root, Gemfile, declared dependencies, schema snapshots.
 *
 * The harness used to keep its own run-global channels and one hierarchy over
 * every language. Production partitions the class-name maps, the return-type
 * maps and the CHA hierarchy by language FAMILY (bd nbf8q / qea83), so on a
 * polyglot corpus a Go method `get` typed a Ruby `get` here and nowhere in a
 * live run. Driving the production state — pass 1 through the extraction
 * sink's own absorb, pass 2 through `CallEdgeResolutionRunner#callSiteContexts`
 * — makes every channel production threads, and every partition it applies,
 * this harness's by construction (bd tea-rags-mcp-pkfi7).
 */
function newProductionRunState(root: string, factory: LanguageFactory): CodegraphRunState {
  const state = new CodegraphRunState(
    collectSchemaColumnSources(factory),
    collectDependencyManifestSources(factory),
    collectStructuralConformanceDerivers(factory),
  );
  state.bindProjectRoot(root);
  state.loadGemfile(root);
  state.loadDeclaredDependencies(root);
  state.loadSchemaSnapshots(root);
  return state;
}

export interface RunResult {
  rows: CallSiteRow[];
  /** Files whose call sites were scored — the `--lang` extensions. */
  files: number;
  /** Files walked into the symbol table only, in some OTHER language. */
  symbolTableOnlyFiles: number;
  /** Dropped by `.gitignore` and friends — production has no index entry at all. */
  ingestIgnored: number;
  /** Indexed for search, but generated / test / non-app code, so no codegraph node. */
  codegraphExcluded: number;
  parseFailures: number;
  symbols: number;
  /**
   * Dispatch-table sites (`CallRef.dispatch`). Resolved and counted as
   * production resolves and counts them; only the chain A/B leaves them out,
   * because production never runs the exact chain on one (bd c6xuu).
   */
  dispatchTableSites: number;
  /** Rebuilt baseline disagreeing with the production resolver. MUST be 0. */
  chainDrift: number;
  /** Did this run consult the dispatch layer at all (bd tea-rags-mcp-w205u)? */
  dispatch: boolean;
  /** Sites the layer collapsed to ONE target, replacing the chain's answer. */
  singleSites: number;
  /** Sites it answered with a hypothesis set of two or more. */
  fanSites: number;
  /** Over-cap decisions: no edges, no fallback. */
  ambiguousSites: number;
  /** Edges the fan sites would persist — Σ `fanSize` over `fan` rows. */
  fanEdges: number;
  /** The corpus-adaptive narrowing cap, read off the function production reads it off. */
  fanoutPolicy: { cap: number; p99DefsPerMember: number };
  /**
   * `--time-only`: no rebuilt chain, so `chainDrift` is structurally 0 and must
   * never be read as "verified". The reporter says so out loud for the same
   * reason this flag exists on the result at all.
   */
  timeOnly: boolean;
  /** Wall/heap accounting, present only under `--timing` (which `--time-only` implies). */
  timing?: ChainTallyTiming;
  /**
   * `--kind-stats`: the per-receiver-kind counters `cg_run_stats` persists,
   * recomputed OFFLINE (bd tea-rags-mcp-1v12o.3). Every counter comes from the
   * runner's own per-site verdict folded by its own `tallyCallSiteVerdict` —
   * production's decision, not a copy — so a denominator change is measurable
   * without a reindex (bd tea-rags-mcp-c6xuu).
   */
  kindStats?: Record<ReceiverKind, ReceiverKindTally>;
  /** Under `--kind-stats`: a few `missWithInProjectDef` sites per kind, for diagnosis. */
  kindSamples?: Record<ReceiverKind, string[]>;
  /** Under `--persisted`: the rows `CallEdgeResolutionRunner#resolve` would persist. */
  persisted?: PersistedEdgeTally;
}

/**
 * What production would WRITE for the scored files (bd tea-rags-mcp-vfmfg): the
 * file and method edges `CallEdgeResolutionRunner#resolve` returns, and how many
 * of each name a `targetRelPath` no corpus file carries — the phantom targets
 * every file-granularity signal (fanIn/fanOut/instability/PageRank) would read.
 */
export interface PersistedEdgeTally {
  fileEdges: number;
  fileEdgesPhantom: number;
  methodEdges: number;
  methodEdgesPhantom: number;
}

/**
 * Misses the rate charges as failures for one kind's row — the shared
 * `contracts/resolve-rate.ts#resolveRateMiss`, the same exclusion list
 * `status-module.ts#missWithInProjectDef` persists rates with.
 */
export function kindMissWithInProjectDef(t: ReceiverKindTally): number {
  return resolveRateMiss(t);
}

/** Knobs the E6 timing legs add; every one of them is off in a default run. */
export interface ChainTallyRunOptions {
  /**
   * Skip the rebuilt chain and the drift check, resolve through the production
   * resolver alone. This is what lets a language with no `ChainSpec` — ruby,
   * typescript — be walked and timed at all.
   */
  timeOnly?: boolean;
  /** Sample RSS, time both passes, count LOC. Implied by `timeOnly`. */
  timing?: boolean;
  /** Recompute the per-receiver-kind run stats offline (bd tea-rags-mcp-1v12o.3). */
  kindStats?: boolean;
  /** Also resolve every scored file through the runner and tally its persisted edges. */
  persisted?: boolean;
}

/** Residual-miss examples printed per kind. Enough to name the shape, not a dump. */
const KIND_SAMPLE_CAP = 6;

function emptyKindSamples(): Record<ReceiverKind, string[]> {
  const out = {} as Record<ReceiverKind, string[]>;
  for (const kind of RECEIVER_KINDS) out[kind] = [];
  return out;
}

/**
 * One call site's contribution to the offline per-kind run stats: the runner's
 * own verdict folded by the runner's own `tallyCallSiteVerdict`, so no bucket,
 * outcome or gate can drift (bd tea-rags-mcp-c6xuu). The harness adds only the
 * residual-miss samples, which production has no counter for.
 */
function tallyKindStats(
  stats: Record<ReceiverKind, ReceiverKindTally>,
  samples: Record<ReceiverKind, string[]>,
  site: { call: CallRef; verdict: CallSiteVerdict; relPath: string },
): void {
  const { verdict, call } = site;
  tallyCallSiteVerdict(stats, verdict);
  if (verdict.missBucket !== "missWithInProjectDef") return;
  const kindSamples = samples[verdict.receiverKind];
  if (kindSamples.length >= KIND_SAMPLE_CAP) return;
  // The RECEIVER and the member, never `callText` — a multi-line call would
  // break one sample across as many lines and make the block ungreppable.
  kindSamples.push(`${site.relPath}:${call.startLine} ${String(call.receiver)}.${call.member}`.replace(/\s+/g, " "));
}

export async function run(
  root: string,
  lang: string,
  deferPass: string | null,
  limit: number,
  quiet: boolean,
  /**
   * Consult the dispatch layer first, as production's default channel does
   * (`resolution-runner.ts:557`). ON by default; `--no-dispatch` reproduces the
   * pre-E4.0.3 walk. It never moves `baseline` / `variant` / `chainDrift` —
   * those stay the exact chain's, which is what the A/B measures.
   */
  dispatch = true,
  opts: ChainTallyRunOptions = {},
): Promise<RunResult> {
  const spec = CHAINS[lang];
  const timeOnly = opts.timeOnly === true;
  const timing = timeOnly || opts.timing === true;
  // The chain REBUILD is what needs a spec; the production resolver does not.
  if (!spec && !timeOnly) {
    throw new Error(
      `no chain spec for language '${lang}' (have: ${Object.keys(CHAINS).join(", ")}); ` +
        `--time-only measures any language the engine walks`,
    );
  }
  if (timeOnly && deferPass) throw new Error("--defer needs a rebuilt chain; drop --time-only");

  const composer = new DefaultSymbolIdComposer();
  // TSCallResolver resolves every candidate path against repoRoot, defaulting to
  // process.cwd() — which for a harness run is the tea-rags checkout, not the
  // corpus. Left unset, a TypeScript run finds no files and declines every call
  // while still LOOKING like a valid walk (the f4wcm class of defect). Neither
  // the python nor the java provider reads it, so the existing legs are unmoved.
  const factory = new LanguageFactory({ repoRoot: root });
  const production = factory.create(lang).resolver;
  if (!production) throw new Error(`language '${lang}' has no resolver`);

  const buildable = timeOnly ? undefined : spec;
  const baselineChain = buildable === undefined ? null : buildable.build();
  const variantChain =
    deferPass && buildable !== undefined
      ? buildable.build().map((s) => (s.name === deferPass ? new DeferFileOnlyStrategy(s) : s))
      : null;
  if (deferPass && baselineChain !== null && !baselineChain.some((s) => s.name === deferPass)) {
    throw new Error(
      `no pass named '${deferPass}' in the ${lang} chain (have: ${baselineChain.map((s) => s.name).join(", ")})`,
    );
  }
  const scoredExts = buildable === undefined ? scoredExtensionsFor(lang) : buildable.extensions;
  const sampler = timing ? startRssSampler() : null;
  const pass1Start = performance.now();

  const symbolTable = new InMemoryGlobalSymbolTable();
  // Run-global, as production's is — every walkable language feeds it, each
  // into its own language family's partition, then pass 2 narrows to the files
  // this resolver owns.
  const runState = newProductionRunState(root, factory);
  const scored: FileExtraction[] = [];
  const corpusFiles = new Set<string>();
  let parseFailures = 0;
  let symbolTableOnlyFiles = 0;

  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    SYMBOL_TABLE_EXTENSIONS,
  );

  for (const relPath of selection.kept.slice(0, limit)) {
    // The run state read the declared dependencies at its run-start seam, as
    // production does; every walk takes production's gate, not an ungated
    // walker's (w205u.1), and the call contexts carry the same set.
    const extraction = extractFile(root, relPath, composer, factory, runState.declaredDependencies);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    absorbPass1FileState(runState, symbolTable, extraction, buildSymbolDefs(extraction), "own");
    corpusFiles.add(relPath);
    if (scoredExts.includes(extname(relPath).toLowerCase())) scored.push(extraction);
    else symbolTableOnlyFiles++;
  }
  const pass1Ms = performance.now() - pass1Start;
  if (!quiet) {
    process.stderr.write(
      `pass 1: ${scored.length} scored files (+${symbolTableOnlyFiles} symbol-table only), ` +
        `${symbolTable.size()} symbols\n`,
    );
  }

  const pass2Start = performance.now();
  const rows: CallSiteRow[] = [];
  const kindStats = opts.kindStats === true ? emptyReceiverKindTally() : null;
  const kindSamples = opts.kindStats === true ? emptyKindSamples() : null;
  let dispatchTableSites = 0;
  let chainDrift = 0;
  let singleSites = 0;
  let fanSites = 0;
  let ambiguousSites = 0;
  let fanEdges = 0;
  // The pass-1→pass-2 barrier, as production crosses it: the per-family
  // hierarchy views, include-by indexes and barrier-derived facts are built
  // over every file the walk absorbed, then each resolver is told its volume.
  await runState.seal(async () => symbolTable);
  const runner = new CallEdgeResolutionRunner(factory, runState);
  runner.prepareResolvePass();

  for (const extraction of scored) {
    // Every call site with the context the production runner resolves it
    // against AND the verdict it reaches there — both built BY the runner, so
    // no channel can be threaded, and no site routed or counted, differently.
    for (const { call, ctx, verdict } of runner.callSiteVerdicts(extraction, symbolTable)) {
      // A dispatch-table site never reaches the exact chain in production — the
      // runner fans it out through `resolveDispatch` and counts it like any
      // other site. It is kept, with its production edges and its counters, but
      // it has no chain answer for the A/B to score (bd tea-rags-mcp-c6xuu).
      const dispatchTable = call.dispatch !== undefined;
      if (dispatchTable) dispatchTableSites++;
      // --time-only asks production directly. There is no rebuilt chain to
      // drift FROM, so `chainDrift` stays 0 and the report says the check did
      // not run — it must never read as "0 drift, verified".
      const baseline = dispatchTable
        ? null
        : baselineChain === null
          ? production.resolve(call, ctx)
          : resolveViaChain(baselineChain, call, ctx);
      if (!dispatchTable && baselineChain !== null && !sameTarget(baseline, production.resolve(call, ctx))) {
        chainDrift++;
      }
      const fan = dispatch ? scoreFan(production, call, ctx) : NO_FAN;
      if (fan.kind === "single") singleSites++;
      else if (fan.kind === "fan") {
        fanSites++;
        fanEdges += fan.fanSize;
      } else if (fan.kind === "ambiguous") ambiguousSites++;
      rows.push({
        relPath: extraction.relPath,
        startLine: call.startLine,
        callText: call.callText,
        receiver: call.receiver,
        member: call.member,
        baseline,
        variant: variantChain && !dispatchTable ? resolveViaChain(variantChain, call, ctx) : baseline,
        baselineTargetInProject: baseline !== null && corpusFiles.has(baseline.targetRelPath),
        dispatchOutcome: fan.kind,
        fanSize: fan.fanSize,
        dispatchTable,
        runnerEdges: verdict.edges,
        runnerAnswer: runnerAnswerOf(verdict),
      });
      if (kindStats !== null && kindSamples !== null) {
        tallyKindStats(kindStats, kindSamples, { call, verdict, relPath: extraction.relPath });
      }
    }
  }
  const pass2Ms = performance.now() - pass2Start;

  let persisted: PersistedEdgeTally | undefined;
  if (opts.persisted === true) {
    persisted = { fileEdges: 0, fileEdgesPhantom: 0, methodEdges: 0, methodEdgesPhantom: 0 };
    for (const extraction of scored) {
      const edges = runner.resolve(extraction, symbolTable);
      persisted.fileEdges += edges.fileEdges.length;
      persisted.fileEdgesPhantom += edges.fileEdges.filter((e) => !corpusFiles.has(e.targetRelPath)).length;
      persisted.methodEdges += edges.methodEdges.length;
      persisted.methodEdgesPhantom += edges.methodEdges.filter((e) => !corpusFiles.has(e.targetRelPath)).length;
    }
  }

  // AFTER pass 2, so this second read pollutes neither number. Counted over the
  // SCORED files only: the normalization is "this language's seconds per this
  // language's lines", and a polyglot corpus's other files are symbol-table
  // input, not the walked source under test.
  let loc = 0;
  if (timing) {
    for (const extraction of scored) {
      const text = readFileSync(resolvePath(root, extraction.relPath), "utf8");
      loc += text.length === 0 ? 0 : text.split("\n").length;
    }
  }

  return {
    rows,
    files: scored.length,
    symbolTableOnlyFiles,
    ingestIgnored: selection.ingestIgnored,
    codegraphExcluded: selection.codegraphExcluded,
    parseFailures,
    symbols: symbolTable.size(),
    dispatchTableSites,
    chainDrift,
    dispatch,
    singleSites,
    fanSites,
    ambiguousSites,
    fanEdges,
    fanoutPolicy: dispatchFanoutPolicyFor(symbolTable),
    kindStats: kindStats ?? undefined,
    kindSamples: kindSamples ?? undefined,
    persisted,
    timeOnly,
    timing:
      sampler === null ? undefined : { pass1Ms, pass2Ms, totalMs: pass1Ms + pass2Ms, peakRssMb: sampler.stop(), loc },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]) {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    corpus: resolvePath(read("--corpus") ?? process.cwd()),
    lang: read("--lang") ?? "python",
    defer: read("--defer") ?? null,
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    samples: Number(read("--samples") ?? 10),
    json: read("--json") ?? null,
    quiet: argv.includes("--quiet"),
    dispatch: !argv.includes("--no-dispatch"),
    timeOnly: argv.includes("--time-only"),
    kindStats: argv.includes("--kind-stats"),
    persisted: argv.includes("--persisted"),
    // `--time-only` implies `--timing`: a mode whose only purpose is the numbers
    // should not need a second flag to print them. `--timing` alone stays legal
    // so a python `--defer` run can also be timed.
    timing: argv.includes("--timing") || argv.includes("--time-only"),
    // `CODEGRAPH_TS_TYPECHECKER=0` is the kill switch the TS resolver actually
    // exposes (`ts-resolver.ts:284`), read once at resolver construction, so the
    // flag is applied to `process.env` in `main` BEFORE the first resolve rather
    // than threaded. ON by default, as production is; the E6 verdict row is the
    // `off` one, where all three languages are tree-sitter-only.
    tsChecker: !argv.includes("--ts-checker=off"),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.tsChecker) process.env.CODEGRAPH_TS_TYPECHECKER = "0";
  const result = await run(opts.corpus, opts.lang, opts.defer, opts.limit, opts.quiet, opts.dispatch, {
    timeOnly: opts.timeOnly,
    timing: opts.timing,
    kindStats: opts.kindStats,
    persisted: opts.persisted,
  });
  // The chain A/B scores only the sites production runs the exact chain on; a
  // dispatch-table site has no chain answer to count as "unresolved".
  const chainRows = result.rows.filter((r) => !r.dispatchTable);
  const baseline = tallyChainOutput(chainRows.map((r) => r.baseline));
  const variant = tallyChainOutput(chainRows.map((r) => r.variant));
  const { tally, changed } = diffRows(chainRows);

  const out: string[] = [
    `CORPUS ${opts.corpus} · lang ${opts.lang}`,
    `  ${result.files} scored files (+${result.symbolTableOnlyFiles} symbol-table only), ${result.symbols} symbols,` +
      ` ${result.rows.length} call sites` +
      ` (parse failures ${result.parseFailures}, dispatch-table sites ${result.dispatchTableSites}` +
      ` — counted, not chain-scored)`,
    `  excluded as production excludes them: ${result.ingestIgnored} by .gitignore and friends · ` +
      `${result.codegraphExcluded} generated/test/non-app`,
    `  chain drift vs production resolver: ${result.chainDrift}${result.chainDrift === 0 ? "" : "  ← REBUILD IS STALE, numbers void"}`,
    "",
    "CHAIN OUTPUT (what the resolver emitted)",
    `  baseline  edges ${baseline.edges} (of which file-only ${baseline.fileOnly}) · unresolved ${baseline.unresolved}`,
    `  baseline  targets naming no corpus file (bd tea-rags-mcp-vfmfg): file-only ${countPhantomTargets(chainRows, true)}` +
      ` · symbol-bearing ${countPhantomTargets(chainRows, false)}`,
  ];
  // Printed apart from the chain block and never summed into it (D3): a fan
  // edge is a hypothesis set at `discount / m`, not a claim the chain made.
  out.push(
    result.dispatch
      ? `  dispatch layer (production consults it FIRST) — cap ${result.fanoutPolicy.cap}` +
          ` (p99 defs-per-member ${result.fanoutPolicy.p99DefsPerMember})` +
          `\n    single ${result.singleSites} (replaced the chain's answer) · fan ${result.fanSites}` +
          ` carrying ${result.fanEdges} edges · ambiguous ${result.ambiguousSites}` +
          ` · untouched ${result.rows.length - result.singleSites - result.fanSites - result.ambiguousSites}`
      : "  dispatch layer NOT run (--no-dispatch) — the pre-E4.0.3 columns",
  );
  // Chain-instrument only: the counter lives on the cache the REBUILT chain
  // feeds, and `--time-only` never builds one. Printing `0` there would report a
  // fallback count for a chain that did not run.
  const extra = result.timeOnly ? undefined : CHAINS[opts.lang]?.report?.();
  if (extra !== undefined) out.push(extra);
  if (opts.defer) {
    out.push(
      `  deferred(${opts.defer})  edges ${variant.edges} (of which file-only ${variant.fileOnly}) · unresolved ${variant.unresolved}`,
      "",
      "DIFF (per call site)",
      `  changed ${changed.length}` +
        ` · upgraded-same-file ${tally.upgradedSameFile}` +
        ` · relocated-other-file ${tally.relocatedOtherFile}` +
        ` · lost ${tally.lost} · gained ${tally.gained} · other ${tally.other}`,
      `  of the relocations: from an IN-PROJECT file ${tally.relocatedFromInProject}` +
        ` · from a PHANTOM external path ${tally.relocatedFromExternal} (fabricated in-project edges)`,
    );
    for (const row of changed.slice(0, opts.samples)) {
      out.push(
        `    ${row.relPath}:${row.startLine} ${row.callText}` +
          `\n      baseline ${describe(row.baseline)}${row.baselineTargetInProject ? " [in-project]" : " [external]"}` +
          `\n      deferred ${describe(row.variant)}`,
      );
    }
  }
  if (result.persisted !== undefined) {
    const p = result.persisted;
    out.push(
      "",
      "PERSISTED EDGES (CallEdgeResolutionRunner#resolve over the scored files)",
      `  file edges ${p.fileEdges} (naming no corpus file ${p.fileEdgesPhantom})` +
        ` · method edges ${p.methodEdges} (naming no corpus file ${p.methodEdgesPhantom})`,
    );
  }
  if (result.kindStats !== undefined) out.push(...formatKindStatsBlock(result.kindStats, result.kindSamples));
  if (result.timing !== undefined) {
    out.push(
      ...formatTimingBlock(result.timing, {
        files: result.files,
        sites: result.rows.length,
        timeOnly: result.timeOnly,
      }),
    );
  }
  process.stdout.write(`${out.join("\n")}\n`);

  if (opts.json) {
    writeFileSync(
      opts.json,
      `${JSON.stringify({ opts, result: { ...result, rows: undefined }, baseline, variant, tally, changed }, null, 2)}\n`,
    );
  }
}

/**
 * The `## Codegraph resolve` per-kind section, recomputed offline. `rate` is
 * `resolved / (resolved + miss)` — the exact `resolveSuccessRate` formula, with
 * `miss` the residual the rate charges as a failure. An empty denominator
 * renders as the `—` marker with the counters kept, never as a rate (bd qodqg).
 */
export function formatKindStatsBlock(
  stats: Record<ReceiverKind, ReceiverKindTally>,
  samples: Record<ReceiverKind, string[]> | undefined,
): string[] {
  const lines = ["", "PER-RECEIVER-KIND RUN STATS (offline recompute of cg_run_stats)"];
  const totals = { resolved: 0, miss: 0 };
  for (const kind of RECEIVER_KINDS) {
    const t = stats[kind];
    if (t.attempted === 0) continue;
    const miss = kindMissWithInProjectDef(t);
    totals.resolved += t.resolved;
    totals.miss += miss;
    const kindDenominator = t.resolved + miss;
    const cell = formatResolveRateCell({
      rate: t.resolved / kindDenominator,
      denominator: kindDenominator,
      counters: `${t.resolved}/${kindDenominator}`,
      renderRate: (rate) => rate.toFixed(3),
    });
    lines.push(
      `  ${kind.padEnd(11)} ${cell}` +
        ` · attempted ${t.attempted} · external ${t.externalSkipped} · noInProjectDef ${t.noInProjectDef}` +
        ` · coreAmbiguous ${t.coreAmbiguous} · unresolvable ${t.unresolvable}` +
        ` · ambiguousFanout ${t.ambiguousFanout} · MISS ${miss}`,
    );
    for (const sample of samples?.[kind] ?? []) lines.push(`      miss: ${sample}`);
  }
  const denominator = totals.resolved + totals.miss;
  const totalCell = formatResolveRateCell({
    rate: totals.resolved / denominator,
    denominator,
    counters: `${totals.resolved}/${denominator}`,
    renderRate: (rate) => rate.toFixed(3),
  });
  lines.push(`  TOTAL       ${totalCell} · residual miss ${totals.miss}`);
  return lines;
}

function describe(target: SymbolResolutionTarget | null): string {
  return target === null ? "(none)" : `${target.targetRelPath} # ${target.targetSymbolId ?? "file-only"}`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop() ?? "")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
