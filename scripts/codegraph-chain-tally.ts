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
 * Two modes:
 *
 *   - default — walk the corpus, run the production chain, report
 *     `edges` / `fileOnly` / `unresolved`.
 *   - `--defer <passName>` — ALSO run a second chain, identical except that the
 *     named pass's file-only commit (`resolved({ targetSymbolId: null })`) is
 *     converted to a `deferred` park, and diff the two per call site.
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
 * Usage:
 *   npx tsx scripts/codegraph-chain-tally.ts --corpus <abs path> --lang python \
 *     [--defer globalShortName] [--limit N] [--samples 10] [--json out.json]
 */

import { writeFileSync } from "node:fs";
import { extname, resolve as resolvePath, sep } from "node:path";

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
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
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

function buildCallContext(
  extraction: FileExtraction,
  chunk: ChunkExtraction,
  symbolTable: InMemoryGlobalSymbolTable,
  channels: RunGlobalTypeChannels,
  hierarchy: HierarchyView,
): CallContext {
  return {
    hierarchy,
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
): Promise<RunResult> {
  const spec = CHAINS[lang];
  if (!spec) throw new Error(`no chain spec for language '${lang}' (have: ${Object.keys(CHAINS).join(", ")})`);

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory();
  const production = factory.create(lang).resolver;
  if (!production) throw new Error(`language '${lang}' has no resolver`);

  const baselineChain = spec.build();
  const variantChain = deferPass
    ? spec.build().map((s) => (s.name === deferPass ? new DeferFileOnlyStrategy(s) : s))
    : null;
  if (deferPass && !baselineChain.some((s) => s.name === deferPass)) {
    throw new Error(
      `no pass named '${deferPass}' in the ${lang} chain (have: ${baselineChain.map((s) => s.name).join(", ")})`,
    );
  }

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

  for (const relPath of selection.kept.slice(0, limit)) {
    const extraction = extractFile(root, relPath, composer, factory);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    absorbTypeChannels(channels, extraction);
    corpusFiles.add(relPath);
    if (spec.extensions.includes(extname(relPath).toLowerCase())) scored.push(extraction);
    else symbolTableOnlyFiles++;
  }
  if (!quiet) {
    process.stderr.write(
      `pass 1: ${scored.length} scored files (+${symbolTableOnlyFiles} symbol-table only), ` +
        `${symbolTable.size()} symbols\n`,
    );
  }

  const rows: CallSiteRow[] = [];
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
      const ctx = buildCallContext(extraction, chunk, symbolTable, channels, hierarchy);
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) {
          dispatchSkipped++;
          continue;
        }
        const baseline = resolveViaChain(baselineChain, call, ctx);
        if (!sameTarget(baseline, production.resolve(call, ctx))) chainDrift++;
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
      }
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
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const result = await run(opts.corpus, opts.lang, opts.defer, opts.limit, opts.quiet, opts.dispatch);
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
  const extra = CHAINS[opts.lang]?.report?.();
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
  process.stdout.write(`${out.join("\n")}\n`);

  if (opts.json) {
    writeFileSync(
      opts.json,
      `${JSON.stringify({ opts, result: { ...result, rows: undefined }, baseline, variant, tally, changed }, null, 2)}\n`,
    );
  }
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
