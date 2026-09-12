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
 * counters `cg_run_stats` persists — through `classifyResolveMiss`, the decision
 * the production runner tallies — so a DENOMINATOR change is measurable without
 * a reindex, next to the edge counts that must not move (bd tea-rags-mcp-1v12o.3).
 *
 * Usage:
 *   npx tsx scripts/codegraph-chain-tally.ts --corpus <abs path> --lang python \
 *     [--defer globalShortName] [--limit N] [--samples 10] [--json out.json] \
 *     [--kind-stats]
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
import { extname, join, resolve as resolvePath, sep } from "node:path";

import { deferred } from "../src/core/contracts/resolution.js";
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type ChunkExtraction,
  type FileExtraction,
  type HierarchyView,
  type InheritanceEdgeRow,
  type ModuleReexport,
  type SymbolResolutionTarget,
} from "../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
  TypeRef,
} from "../src/core/contracts/types/language.js";
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
import {
  createPythonSymbolResolutionChain,
  PythonAncestorLinearizerCache,
  PythonImportFileMapper,
} from "../src/core/domains/language/python/resolver/index.js";
import { CONE_MAX_DEFAULT } from "../src/core/domains/language/python/resolver/strategies/index.js";
import { resolveViaChain } from "../src/core/domains/language/resolver-chain.js";
import { MapHierarchyView } from "../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import {
  buildHierarchySnapshot,
  normalizeInheritanceEdges,
} from "../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import {
  classifyReceiverKind,
  RECEIVER_KINDS,
  type ReceiverKind,
} from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { classifyResolveMiss } from "../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import {
  emptyReceiverKindTally,
  type ReceiverKindTally,
} from "../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { NO_FAN, scoreFan, type PyFanOutcomeKind } from "./lib/py-oracle-core.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
  readCorpusDeclaredDependencies,
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
 * leg is `.ts`/`.tsx` and JavaScript gets a leg of its own for free.
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
   * The answer PRODUCTION books: the dispatch layer's single target when it
   * pinned one, else the exact chain's, and null where a fan or an over-cap
   * decision left production with no 1:1 edge. `baseline` deliberately stays
   * the EXACT chain — the A/B this script exists for is a chain instrument, and
   * folding a fan into it would make a real drift invisible (Step 7).
   */
  runnerAnswer: SymbolResolutionTarget | null;
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
 * The run-global type channels production merges at the pass-1→pass-2 barrier
 * (`CodegraphRunState`), accumulated here across every walked file.
 *
 * `classExtends` was already shaped this way; the other three ride the same
 * barrier and a resolver pass that reads them — Python's `chainType` reads
 * `structuredReturnTypes` — measures a no-op without them (bd
 * tea-rags-mcp-9fgdi, decision 7).
 */
interface RunGlobalTypeChannels {
  classExtends: Record<string, string>;
  structuredReturnTypes: Record<string, TypeRef>;
  functionReturnTypes: Record<string, string>;
  classAncestors: Record<string, readonly string[]>;
  /** `<relPath>::<class FQ>` → field → type, the run-global field address (f0xaa). */
  classFieldTypesByClassKey: Record<string, Record<string, string>>;
  /** The same address for a field assigned from a CALL — the callee spelling (w205u, E4.6c). */
  classFieldCallResults: Record<string, Record<string, string>>;
  /** `relPath` → the names its `from` statements bind, for the mapper's re-export hop (xpl83.3). */
  moduleReexports: Record<string, readonly ModuleReexport[]>;
  /**
   * Inheritance rows and instantiated types, the two channels the CHA cone
   * reads (bd tea-rags-mcp-o17v2 / pffv, wired here by w205u/E4.0.3). Without
   * them `ctx.hierarchy` is undefined and `resolveDispatch` returns `[]` at
   * every site, so the tally reported a dispatch layer that never ran.
   */
  inheritanceRows: InheritanceEdgeRow[];
  instantiatedTypes: Set<string>;
}

/** Absorb one file's contribution to every run-global channel. */
function absorbTypeChannels(channels: RunGlobalTypeChannels, extraction: FileExtraction): void {
  Object.assign(channels.classExtends, extraction.classExtends ?? {});
  Object.assign(channels.structuredReturnTypes, extraction.structuredReturnTypes ?? {});
  Object.assign(channels.functionReturnTypes, extraction.functionReturnTypes ?? {});
  Object.assign(channels.classAncestors, extraction.classAncestors ?? {});
  for (const [classKey, fields] of Object.entries(extraction.classFieldTypesByClassKey ?? {})) {
    channels.classFieldTypesByClassKey[classKey] = { ...channels.classFieldTypesByClassKey[classKey], ...fields };
  }
  for (const [classKey, fields] of Object.entries(extraction.classFieldCallResults ?? {})) {
    channels.classFieldCallResults[classKey] = { ...channels.classFieldCallResults[classKey], ...fields };
  }
  if (extraction.moduleReexports) channels.moduleReexports[extraction.relPath] = extraction.moduleReexports;
  // `() => null` mirrors the extraction sink: the cone reads ancestors by
  // fqName, and pass 1's table cannot bind symbol ids yet anyway.
  channels.inheritanceRows.push(...normalizeInheritanceEdges(extraction, () => null));
  for (const instantiated of extraction.instantiatedTypes ?? []) channels.instantiatedTypes.add(instantiated);
}

/**
 * The channels only the Ruby fold reads, kept apart from {@link RunGlobalTypeChannels}
 * rather than folded into it. Two reasons, and both are load-bearing: Ruby's
 * `classFieldTypes` is RUN-GLOBAL where the Python/Java context passes the
 * per-file one, so merging the two shapes would silently move a Python answer;
 * and the byte-identity gate on the existing python/java runs only holds if
 * their `CallContext` is assembled exactly as before. Copied from
 * `scripts/spikes/ruby-resolver-parity.ts`, which is the gate these channels
 * already answer to — a channel absent here is a branch the Ruby leg never
 * reaches, and its wall would then be a measurement of a shorter chain.
 */
interface RubyRunGlobalChannels {
  classFieldTypes: NonNullable<CallContext["classFieldTypes"]>;
  classPrependedAncestors: NonNullable<CallContext["classPrependedAncestors"]>;
  ivarTypes: NonNullable<CallContext["ivarTypes"]>;
  compactDeclaredClasses: Set<string>;
  /** The project's `Gemfile`, as the provider reads it once per run; absent ⇒ ungated catalogue. */
  gemfileContent: string | undefined;
  /** Zeitwerk's autoload root — the corpus, never the harness's cwd. */
  projectRoot: string;
}

function emptyRubyChannels(root: string): RubyRunGlobalChannels {
  let gemfileContent: string | undefined;
  try {
    gemfileContent = readFileSync(join(root, "Gemfile"), "utf8");
  } catch {
    gemfileContent = undefined;
  }
  return {
    classFieldTypes: {},
    classPrependedAncestors: {},
    ivarTypes: {},
    compactDeclaredClasses: new Set<string>(),
    gemfileContent,
    projectRoot: root,
  };
}

function absorbRubyChannels(channels: RubyRunGlobalChannels, extraction: FileExtraction): void {
  Object.assign(channels.classFieldTypes, extraction.classFieldTypes ?? {});
  Object.assign(channels.classPrependedAncestors, extraction.classPrependedAncestors ?? {});
  Object.assign(channels.ivarTypes, extraction.ivarTypes ?? {});
  for (const fq of extraction.compactDeclaredClasses ?? []) channels.compactDeclaredClasses.add(fq);
}

/** The Ruby-only half of one call site's context; `{}` for every other language. */
function rubyCallContext(
  extraction: FileExtraction,
  chunk: ChunkExtraction,
  channels: RubyRunGlobalChannels | null,
): Partial<CallContext> {
  if (channels === null) return {};
  return {
    classFieldTypes: channels.classFieldTypes,
    classPrependedAncestors: channels.classPrependedAncestors,
    ivarTypes: channels.ivarTypes,
    compactDeclaredClasses: channels.compactDeclaredClasses,
    associationTypes: extraction.associationTypes,
    localCallBindings: chunk.localCallBindings,
    gemfileContent: channels.gemfileContent,
    projectRoot: channels.projectRoot,
  };
}

function buildCallContext(
  extraction: FileExtraction,
  chunk: ChunkExtraction,
  symbolTable: InMemoryGlobalSymbolTable,
  channels: RunGlobalTypeChannels,
  hierarchy: HierarchyView,
  ruby: RubyRunGlobalChannels | null = null,
  declaredDependencies: ReadonlySet<string> | undefined = undefined,
): CallContext {
  return {
    hierarchy,
    declaredDependencies,
    instantiatedTypes: channels.instantiatedTypes,
    callerFile: extraction.relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: extraction.imports,
    symbolTable,
    classFieldTypes: extraction.classFieldTypes,
    localBindings: chunk.localBindings,
    callResultBindings: chunk.callResultBindings,
    classExtends: channels.classExtends,
    structuredReturnTypes: channels.structuredReturnTypes,
    functionReturnTypes: channels.functionReturnTypes,
    classAncestors: channels.classAncestors,
    classFieldTypesByClassKey: channels.classFieldTypesByClassKey,
    classFieldCallResults: channels.classFieldCallResults,
    moduleReexports: channels.moduleReexports,
    // LAST, so the Ruby leg's run-global `classFieldTypes` wins over the
    // per-file one above. `{}` for every other language, which is what keeps
    // the python/java context byte-identical to the pre-E6 one.
    ...rubyCallContext(extraction, chunk, ruby),
  };
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
  dispatchSkipped: number;
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
   * recomputed OFFLINE (bd tea-rags-mcp-1v12o.3). The buckets come from
   * `classifyResolveMiss` — production's own decision, not a copy — so a
   * denominator change is measurable without a reindex.
   */
  kindStats?: Record<ReceiverKind, ReceiverKindTally>;
  /** Under `--kind-stats`: a few `missWithInProjectDef` sites per kind, for diagnosis. */
  kindSamples?: Record<ReceiverKind, string[]>;
}

/**
 * Misses the rate charges as failures — `status-module.ts#missWithInProjectDef`
 * for one kind's row. `ambiguousFanout` is deliberately NOT subtracted: the
 * strict rate keeps an over-cap fan in the denominator.
 */
export function kindMissWithInProjectDef(t: ReceiverKindTally): number {
  return Math.max(
    0,
    t.attempted - t.resolved - t.externalSkipped - t.unresolvable - t.noInProjectDef - t.coreAmbiguous,
  );
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
}

/** Residual-miss examples printed per kind. Enough to name the shape, not a dump. */
const KIND_SAMPLE_CAP = 6;

function emptyKindSamples(): Record<ReceiverKind, string[]> {
  const out = {} as Record<ReceiverKind, string[]>;
  for (const kind of RECEIVER_KINDS) out[kind] = [];
  return out;
}

/**
 * One call site's contribution to the offline per-kind run stats. Mirrors
 * `CallEdgeResolutionRunner#resolveMethodEdges`'s tally block — the SAME
 * `classifyResolveMiss` production calls, so the buckets cannot drift.
 */
function tallyKindStats(
  stats: Record<ReceiverKind, ReceiverKindTally>,
  samples: Record<ReceiverKind, string[]>,
  site: {
    call: CallRef;
    ctx: CallContext;
    chunk: ChunkExtraction;
    resolver: Parameters<typeof classifyResolveMiss>[2];
    symbolTable: InMemoryGlobalSymbolTable;
    relPath: string;
    resolved: boolean;
    ambiguous: boolean;
  },
): void {
  const kind = classifyReceiverKind(site.call, site.chunk.localBindings);
  const row = stats[kind];
  row.attempted += 1;
  if (site.ambiguous) {
    row.ambiguousFanout += 1;
    return;
  }
  if (site.resolved) {
    row.resolved += 1;
    return;
  }
  const bucket = classifyResolveMiss(site.call, site.ctx, site.resolver, site.symbolTable);
  if (bucket === "missWithInProjectDef") {
    if (samples[kind].length < KIND_SAMPLE_CAP) {
      // The RECEIVER and the member, never `callText` — a multi-line call would
      // break one sample across as many lines and make the block ungreppable.
      samples[kind].push(
        `${site.relPath}:${site.call.startLine} ${String(site.call.receiver)}.${site.call.member}`.replace(/\s+/g, " "),
      );
    }
    return;
  }
  row[bucket] += 1;
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
  const rubyChannels = lang === "ruby" ? emptyRubyChannels(root) : null;
  const sampler = timing ? startRssSampler() : null;
  const pass1Start = performance.now();

  const symbolTable = new InMemoryGlobalSymbolTable();
  // Run-global, as `CodegraphRunState` is — every walkable language feeds
  // them, then pass 2 narrows to the files this resolver owns.
  const channels: RunGlobalTypeChannels = {
    classExtends: {},
    structuredReturnTypes: {},
    functionReturnTypes: {},
    classAncestors: {},
    classFieldTypesByClassKey: {},
    classFieldCallResults: {},
    moduleReexports: {},
    inheritanceRows: [],
    instantiatedTypes: new Set<string>(),
  };
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

  // Read ONCE per corpus, exactly where production reads it (run start), and
  // threaded into every walk AND every call context below — the tally must be
  // taken with production's gate, not with an ungated walker (w205u.1).
  const declaredDependencies = readCorpusDeclaredDependencies(root, factory);

  for (const relPath of selection.kept.slice(0, limit)) {
    const extraction = extractFile(root, relPath, composer, factory, declaredDependencies);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    absorbTypeChannels(channels, extraction);
    if (rubyChannels !== null) absorbRubyChannels(rubyChannels, extraction);
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
  let dispatchSkipped = 0;
  let chainDrift = 0;
  let singleSites = 0;
  let fanSites = 0;
  let ambiguousSites = 0;
  let fanEdges = 0;
  // Built at the same pass-1→pass-2 barrier production builds it at, over every
  // file the walk absorbed — the cone reads it by fqName, so it must be whole
  // before the first call resolves.
  const hierarchy = new MapHierarchyView(buildHierarchySnapshot(channels.inheritanceRows));

  for (const extraction of scored) {
    for (const chunk of extraction.chunks) {
      const ctx = buildCallContext(
        extraction,
        chunk,
        symbolTable,
        channels,
        hierarchy,
        rubyChannels,
        declaredDependencies,
      );
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) {
          dispatchSkipped++;
          continue;
        }
        // --time-only asks production directly. There is no rebuilt chain to
        // drift FROM, so `chainDrift` stays 0 and the report says the check did
        // not run — it must never read as "0 drift, verified".
        const baseline =
          baselineChain === null ? production.resolve(call, ctx) : resolveViaChain(baselineChain, call, ctx);
        if (baselineChain !== null && !sameTarget(baseline, production.resolve(call, ctx))) chainDrift++;
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
          variant: variantChain ? resolveViaChain(variantChain, call, ctx) : baseline,
          baselineTargetInProject: baseline !== null && corpusFiles.has(baseline.targetRelPath),
          dispatchOutcome: fan.kind,
          fanSize: fan.fanSize,
          runnerAnswer: fan.kind === "single" ? fan.single : fan.kind === "none" ? baseline : null,
        });
        if (kindStats !== null && kindSamples !== null) {
          tallyKindStats(kindStats, kindSamples, {
            call,
            ctx,
            chunk,
            resolver: production,
            symbolTable,
            relPath: extraction.relPath,
            // The runner books a fan or a single as RESOLVED (it pushed edges);
            // only `ambiguous` and a declining chain reach miss classification.
            resolved: fan.kind === "single" || fan.kind === "fan" || (fan.kind === "none" && baseline !== null),
            ambiguous: fan.kind === "ambiguous",
          });
        }
      }
    }
  }
  const pass2Ms = performance.now() - pass2Start;

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
    dispatchSkipped,
    chainDrift,
    dispatch,
    singleSites,
    fanSites,
    ambiguousSites,
    fanEdges,
    fanoutPolicy: dispatchFanoutPolicyFor(symbolTable),
    kindStats: kindStats ?? undefined,
    kindSamples: kindSamples ?? undefined,
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
  });
  const baseline = tallyChainOutput(result.rows.map((r) => r.baseline));
  const variant = tallyChainOutput(result.rows.map((r) => r.variant));
  const { tally, changed } = diffRows(result.rows);

  const out: string[] = [
    `CORPUS ${opts.corpus} · lang ${opts.lang}`,
    `  ${result.files} scored files (+${result.symbolTableOnlyFiles} symbol-table only), ${result.symbols} symbols,` +
      ` ${result.rows.length} call sites` +
      ` (parse failures ${result.parseFailures}, dispatch skipped ${result.dispatchSkipped})`,
    `  excluded as production excludes them: ${result.ingestIgnored} by .gitignore and friends · ` +
      `${result.codegraphExcluded} generated/test/non-app`,
    `  chain drift vs production resolver: ${result.chainDrift}${result.chainDrift === 0 ? "" : "  ← REBUILD IS STALE, numbers void"}`,
    "",
    "CHAIN OUTPUT (what the resolver emitted)",
    `  baseline  edges ${baseline.edges} (of which file-only ${baseline.fileOnly}) · unresolved ${baseline.unresolved}`,
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
 * `miss` the residual the rate charges as a failure.
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
    const rate = t.resolved + miss === 0 ? 1 : t.resolved / (t.resolved + miss);
    lines.push(
      `  ${kind.padEnd(11)} ${rate.toFixed(3)} ${t.resolved}/${t.resolved + miss}` +
        ` · attempted ${t.attempted} · external ${t.externalSkipped} · noInProjectDef ${t.noInProjectDef}` +
        ` · coreAmbiguous ${t.coreAmbiguous} · unresolvable ${t.unresolvable}` +
        ` · ambiguousFanout ${t.ambiguousFanout} · MISS ${miss}`,
    );
    for (const sample of samples?.[kind] ?? []) lines.push(`      miss: ${sample}`);
  }
  const denominator = totals.resolved + totals.miss;
  lines.push(
    `  TOTAL       ${(denominator === 0 ? 1 : totals.resolved / denominator).toFixed(3)}` +
      ` ${totals.resolved}/${denominator} · residual miss ${totals.miss}`,
  );
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
