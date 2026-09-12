/**
 * What an INCREMENTAL codegraph run still loses on a real corpus, per receiver
 * kind AND per call edge, with no index run at all (bd tea-rags-mcp-8qyax,
 * generalised to Python by bd tea-rags-mcp-4yvms).
 *
 * The defect class: `GlobalSymbolTable` hydrates from `cg_symbols` when the
 * collection opens, so DEFINITION lookups are project-wide on every run, while
 * `CodegraphRunState`'s run-global maps are built in `absorb` from the files the
 * CURRENT batch walked. bd znxg8 closed that gap for the ancestry and
 * self-dispatch families by persisting them (`cg_pass1_aggregates`, migration
 * 021) and hydrating them at the barrier. The TYPE-INFERENCE family —
 * `structuredReturnTypes`, `ivarTypes`, `instantiatedTypes`, `dispatchTables`,
 * `callbackParams`, `paramNames`, `classField*` — was left batch-scoped on the
 * grounds that those are per-METHOD, so persisting them would grow the slice
 * from "proportional to classes" to "proportional to methods".
 *
 * This harness is what tested that. Its `--ablate` sweep named the two channels
 * that actually mattered (`structuredReturnTypes` 111 edges, `returnTypes` 20,
 * everything else exactly 0) and its size read-out refuted the premise — the
 * per-method map holds 6518 entries against 11099 per-class ancestry keys the
 * slice already carried. Both are persisted as of bd tea-rags-mcp-8qyax, so a
 * plain run now reads a residue rather than the original 168, and the sweep is
 * kept as the instrument that says so — and that would catch a regression.
 *
 * Both sides walk the SAME working tree and resolve the SAME files against the
 * SAME project-wide symbol table; the only difference is which run-global maps
 * the barrier had:
 *
 *   FULL — every file absorbed, so every map is complete (the reference).
 *   INC  — only the batch absorbed, then `seal` hydrates the persisted pass-1
 *          slices for every OTHER file, exactly as production does.
 *
 * So the per-kind delta is attributable to the maps hydration does NOT carry.
 * A delta inside the noise floor means nothing is left worth persisting; a delta
 * concentrated in one receiver kind names the map that is.
 *
 * ── Why the EDGE-SET diff exists alongside the counts ──
 * `Δresolved` is a count, and the defect this whole line of work chases is a
 * MIS-resolution: an entry call that lands on the shared mixin's own method
 * instead of the concrete subclass resolved to *a* symbol, so every count-based
 * rate reads it as a success. Counts can therefore be flat while the graph is
 * wrong. {@link diffCallEdges} keys each method edge by its call SITE — (caller
 * relPath, caller symbolId, call expression) — and compares the TARGET SETS, so
 * a call site answered differently by the two runs shows up as `retargeted`
 * even when both runs answered it. That is the number this instrument exists
 * for; `Δresolved` is the cheaper summary beside it.
 *
 * ── Languages ──
 * `--language` selects the corpus extensions (read off production's
 * `CODEGRAPH_LANGUAGES` rather than a table of its own) and the per-language
 * tally the rates are read from. Everything else is language-neutral: the
 * run-start seams mirror the provider's `bindRunState` for both, so a Python
 * corpus is walked with the same gated framework vocabulary production gates it
 * with. Default `ruby`, so every invocation documented before the generalisation
 * still means what it said.
 *
 * Usage:
 *   npx tsx scripts/spikes/incremental-runglobal-delta.ts \
 *     --corpus /abs/path/to/repo [--language ruby|python] \
 *     [--batches 4] [--batch-size 40] [--limit N] [--ablate none] [--json out.json]
 */
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { CodegraphPass1FileAggregates } from "../../src/core/contracts/types/codegraph-pass1.js";
import type {
  FileExtraction,
  GlobalSymbolTable,
  GraphEdges,
  RelPath,
} from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { collectSchemaColumnSources } from "../../src/core/domains/trajectory/codegraph/exclusion.js";
import { buildPass1Aggregates } from "../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CODEGRAPH_LANGUAGES } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import {
  RECEIVER_KINDS,
  type ReceiverKind,
} from "../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { CallEdgeResolutionRunner } from "../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState, languageKindTally } from "../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { extractSelfDispatchMethods } from "../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectDependencyManifestSources } from "../../src/core/infra/dependency-manifests.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
  readCorpusDeclaredDependencies,
} from "../ts-codegraph-typechecker-oracle.js";

/** The corpora this instrument has been exercised on. */
const LANGUAGES = ["ruby", "python"] as const;
type HarnessLanguage = (typeof LANGUAGES)[number];

/**
 * Which extensions belong to this language, read off the SAME table production
 * walks by (`CODEGRAPH_LANGUAGES`) rather than a hand-kept list. A language that
 * gains an extension gains it here too, and the harness cannot silently measure
 * a narrower corpus than the indexer walks.
 */
function extensionsFor(language: HarnessLanguage): readonly string[] {
  return Object.entries(CODEGRAPH_LANGUAGES)
    .filter(([, config]) => config.language === language)
    .map(([ext]) => ext);
}

/**
 * The provider's run-start seam, mirrored (`provider.ts` `bindRunState`).
 *
 * All four calls, for both languages, because production makes all four for
 * both: `loadGemfile` is a guarded no-op without a Gemfile, `loadSchemaSnapshots`
 * one without a schema snapshot, and `loadDeclaredDependencies` is what gates
 * each language's conditional framework vocabulary — skipping it would walk a
 * Python corpus with the FULL vocabulary while production walked it with a gated
 * one, and the number reported would then be of a gate nothing ships.
 */
function bindRunStart(state: CodegraphRunState, root: string): void {
  state.bindProjectRoot(root);
  state.loadGemfile(root);
  state.loadDeclaredDependencies(root);
  state.loadSchemaSnapshots(root);
}

/**
 * A run state wired exactly as the provider's constructor wires it — the two
 * language-contributed source vocabularies included, because an empty
 * `dependencyManifestSources` makes {@link bindRunStart}'s
 * `loadDeclaredDependencies` answer `undefined` and leaves every vocabulary
 * active.
 */
function newRunState(factory: LanguageFactory): CodegraphRunState {
  return new CodegraphRunState(collectSchemaColumnSources(factory), collectDependencyManifestSources(factory));
}

/** Production gates self-dispatch discovery on Ruby in both of its call sites; so does this. */
function selfDispatchFor(extraction: FileExtraction): ReturnType<typeof extractSelfDispatchMethods> {
  return extraction.language === "ruby" ? extractSelfDispatchMethods(extraction.chunks) : [];
}

/**
 * A fresh IDENTITY over the same symbol data — one per resolve pass, and the
 * thing that makes this harness honest about the maps under test.
 *
 * Resolvers memoize per symbol-table INSTANCE, through a `WeakMap` keyed by the
 * table object: `PythonImportFileMapper.memos` and `dispatchFanoutPolicyFor`'s
 * `policyCache`. The mapper's memo caches the answers to "which file DECLARES
 * this name" and "which module does this alias name" — both computed FROM
 * `ctx.moduleReexports`. Handing both sides the same table object therefore let
 * the FULL pass, which runs first, populate that cache with answers derived
 * from a COMPLETE `moduleReexports`, and the incremental pass read them back
 * without ever consulting its own (batch-sized) map. The `--ablate reexp` sweep
 * then compared a map against a cache of itself and could only ever report
 * zero. One production run owns one table and one memo, so a per-pass identity
 * is also the faithful shape, not merely the fair one.
 *
 * A wrapper rather than a second populated table: the data is identical by
 * construction this way, and only the memo key changes. The optional members
 * are forwarded conditionally, because consumers capability-detect them
 * (`table.listFiles !== undefined` decides Python's source-root inference).
 */
function symbolTableView(delegate: GlobalSymbolTable): GlobalSymbolTable {
  const view: GlobalSymbolTable = {
    upsertFile: (relPath, definitions) => {
      delegate.upsertFile(relPath, definitions);
    },
    removeFile: (relPath) => {
      delegate.removeFile(relPath);
    },
    lookup: (fqName) => delegate.lookup(fqName),
    lookupByShortName: (name, options) => delegate.lookupByShortName(name, options),
    hasFile: (relPath) => delegate.hasFile(relPath),
    hasFilesUnder: (dirRelPath) => delegate.hasFilesUnder(dirRelPath),
    size: () => delegate.size(),
    hydrate: (definitions) => {
      delegate.hydrate(definitions);
    },
    shortNameDefCounts: () => delegate.shortNameDefCounts(),
  };
  if (delegate.setSchemaColumns !== undefined) {
    view.setSchemaColumns = (definitions) => delegate.setSchemaColumns?.(definitions);
  }
  if (delegate.hydrateFiles !== undefined) {
    view.hydrateFiles = (relPaths) => delegate.hydrateFiles?.(relPaths);
  }
  if (delegate.listFiles !== undefined) {
    view.listFiles = () => delegate.listFiles?.() ?? [];
  }
  return view;
}

/** The four numbers a receiver-kind bucket is compared on. */
interface KindSlice {
  attempted: number;
  resolved: number;
  externalSkipped: number;
  unnarrowedTemplate: number;
}

const emptySlice = (): KindSlice => ({ attempted: 0, resolved: 0, externalSkipped: 0, unnarrowedTemplate: 0 });

/**
 * Snapshot the per-kind tally for the language under test. Taken BEFORE and
 * AFTER each batch and subtracted, because `CodegraphRunState.stats` accumulates
 * across every `resolve` a runner performs and the FULL side reuses one sealed
 * state for every batch — re-sealing per batch would re-run the discovery over
 * the whole corpus for no gain.
 */
function snapshotKinds(state: CodegraphRunState, language: HarnessLanguage): Record<ReceiverKind, KindSlice> {
  const tally = languageKindTally(state.stats, language);
  const out = {} as Record<ReceiverKind, KindSlice>;
  for (const kind of RECEIVER_KINDS) {
    const t = tally[kind];
    out[kind] = {
      attempted: t.attempted,
      resolved: t.resolved,
      externalSkipped: t.externalSkipped,
      unnarrowedTemplate: t.unnarrowedTemplate,
    };
  }
  return out;
}

function subtractKinds(
  after: Record<ReceiverKind, KindSlice>,
  before: Record<ReceiverKind, KindSlice>,
): Record<ReceiverKind, KindSlice> {
  const out = {} as Record<ReceiverKind, KindSlice>;
  for (const kind of RECEIVER_KINDS) {
    out[kind] = {
      attempted: after[kind].attempted - before[kind].attempted,
      resolved: after[kind].resolved - before[kind].resolved,
      externalSkipped: after[kind].externalSkipped - before[kind].externalSkipped,
      unnarrowedTemplate: after[kind].unnarrowedTemplate - before[kind].unnarrowedTemplate,
    };
  }
  return out;
}

function addInto(target: Record<ReceiverKind, KindSlice>, delta: Record<ReceiverKind, KindSlice>): void {
  for (const kind of RECEIVER_KINDS) {
    target[kind].attempted += delta[kind].attempted;
    target[kind].resolved += delta[kind].resolved;
    target[kind].externalSkipped += delta[kind].externalSkipped;
    target[kind].unnarrowedTemplate += delta[kind].unnarrowedTemplate;
  }
}

const emptyKinds = (): Record<ReceiverKind, KindSlice> => {
  const out = {} as Record<ReceiverKind, KindSlice>;
  for (const kind of RECEIVER_KINDS) out[kind] = emptySlice();
  return out;
};

/** `resolved / max(1, attempted − externalSkipped)` — the same shape as the persisted rate. */
const rate = (s: KindSlice): number => s.resolved / Math.max(1, s.attempted - s.externalSkipped);

// ---------------------------------------------------------------------------
// Edge-set diff — the half that catches MIS-resolution.
// ---------------------------------------------------------------------------

/**
 * One call site's answer set: `target id → edge kind`. The site is keyed by
 * (caller relPath, caller symbolId, call expression) because that is every
 * coordinate a `GraphEdges.methodEdges` entry carries — there is no call-site
 * LINE on the edge, so two textually identical calls from the same method
 * collapse into one site. They collapse identically on BOTH sides, so the diff
 * stays sound; what it loses is the ability to say "two of the three answers
 * moved" for such a site, which no persisted rate can say either.
 *
 * A target with no in-project symbol is keyed by its relPath under a `@` prefix,
 * a spelling no symbolId can collide with.
 */
type CallSiteAnswers = Map<string, Map<string, string>>;

function indexCallEdges(relPath: string, edges: GraphEdges, into: CallSiteAnswers): void {
  for (const edge of edges.methodEdges) {
    const site = `${relPath} ${edge.sourceSymbolId} ${edge.callExpression}`;
    const target = edge.targetSymbolId ?? `@${edge.targetRelPath}`;
    let answers = into.get(site);
    if (answers === undefined) {
      answers = new Map();
      into.set(site, answers);
    }
    answers.set(target, edge.edgeKind ?? "exact");
  }
}

/**
 * How the two runs' call graphs differ, in edges rather than counts.
 *
 * `lost` / `phantom` / `retargeted` partition the disagreement so that each
 * edge is counted once and the three names mean what they say:
 *
 *  - a call site only the FULL run answered contributes every target to `lost`;
 *  - a site only the INC run answered contributes every target to `phantom`;
 *  - a site BOTH answered, differently, contributes `min(|missing|, |extra|)`
 *    to `retargeted` — the incremental run sent the same call somewhere else —
 *    and only the asymmetric remainder to `lost` / `phantom`. Without the
 *    pairing a single re-pointed edge would be double-reported as one loss
 *    plus one phantom, and the shape the bead is about (the answer MOVED, the
 *    count did not) would be invisible in the totals.
 *
 * `missingByKind` / `extraByKind` are the raw per-`edgeKind` tallies of the two
 * asymmetric sets BEFORE the pairing, kept because the kind is what names the
 * degradation: an `exact` edge replaced by a `cone` one is a precision loss, a
 * `cone` replaced by `cone` is a different target inside the same fan-out.
 */
export interface CallEdgeDiff {
  fullEdges: number;
  incEdges: number;
  fullSites: number;
  incSites: number;
  sharedSites: number;
  lost: number;
  phantom: number;
  retargeted: number;
  missingByKind: Record<string, number>;
  extraByKind: Record<string, number>;
}

const emptyEdgeDiff = (): CallEdgeDiff => ({
  fullEdges: 0,
  incEdges: 0,
  fullSites: 0,
  incSites: 0,
  sharedSites: 0,
  lost: 0,
  phantom: 0,
  retargeted: 0,
  missingByKind: {},
  extraByKind: {},
});

export function diffCallEdges(full: CallSiteAnswers, inc: CallSiteAnswers): CallEdgeDiff {
  const diff = emptyEdgeDiff();
  const bump = (bucket: Record<string, number>, kind: string): void => {
    bucket[kind] = (bucket[kind] ?? 0) + 1;
  };

  for (const [site, fullAnswers] of full) {
    diff.fullEdges += fullAnswers.size;
    diff.fullSites += 1;
    const incAnswers = inc.get(site);
    if (incAnswers === undefined) {
      diff.lost += fullAnswers.size;
      for (const kind of fullAnswers.values()) bump(diff.missingByKind, kind);
      continue;
    }
    diff.sharedSites += 1;
    let missing = 0;
    let extra = 0;
    for (const [target, kind] of fullAnswers) {
      if (incAnswers.has(target)) continue;
      missing += 1;
      bump(diff.missingByKind, kind);
    }
    for (const [target, kind] of incAnswers) {
      if (fullAnswers.has(target)) continue;
      extra += 1;
      bump(diff.extraByKind, kind);
    }
    const paired = Math.min(missing, extra);
    diff.retargeted += paired;
    diff.lost += missing - paired;
    diff.phantom += extra - paired;
  }

  for (const [site, incAnswers] of inc) {
    diff.incEdges += incAnswers.size;
    diff.incSites += 1;
    if (full.has(site)) continue;
    diff.phantom += incAnswers.size;
    for (const kind of incAnswers.values()) bump(diff.extraByKind, kind);
  }
  return diff;
}

function addEdgeDiff(target: CallEdgeDiff, delta: CallEdgeDiff): void {
  target.fullEdges += delta.fullEdges;
  target.incEdges += delta.incEdges;
  target.fullSites += delta.fullSites;
  target.incSites += delta.incSites;
  target.sharedSites += delta.sharedSites;
  target.lost += delta.lost;
  target.phantom += delta.phantom;
  target.retargeted += delta.retargeted;
  for (const [kind, n] of Object.entries(delta.missingByKind)) {
    target.missingByKind[kind] = (target.missingByKind[kind] ?? 0) + n;
  }
  for (const [kind, n] of Object.entries(delta.extraByKind)) {
    target.extraByKind[kind] = (target.extraByKind[kind] ?? 0) + n;
  }
}

/**
 * Which family of run-global maps to hand the incremental side, on top of what
 * hydration already carries. This is the ABLATION: hydration cannot supply these
 * today, so copying one family from the full run answers "what would persisting
 * exactly this recover?" without first building the persistence.
 *
 * `types` is the coarse family kept for continuity with the first sweep;
 * `sret` / `fret` / `ivar` split it, and the split is what made the result
 * actionable — the three turned out to be independent (111 + 20 + 0), so two
 * shipped and one did not. `params` stays grouped because its members are
 * derived from each other at `seal` and handing over a subset would measure a
 * state no run can be in.
 *
 * `cft` and `reexp` are the Python pair bd tea-rags-mcp-4yvms weighs. They are
 * separate entries, not one `python` family, for the same reason `sret`/`fret`
 * are: they are read by different strategies, cost different amounts to persist,
 * and there is no reason to assume they buy the same thing.
 */
const ABLATIONS = [
  "none",
  "types",
  "sret",
  "fret",
  "ivar",
  "rta",
  "dispatch",
  "params",
  "cft",
  "reexp",
  "all",
] as const;
type Ablation = (typeof ABLATIONS)[number];

/**
 * Overlay `full`'s maps onto `inc` for the chosen family. Run AFTER `seal`,
 * because seal DERIVES `paramTypes` / `derivedClassFieldTypes` from the raw
 * channels and would overwrite anything written before it.
 */
function ablate(inc: CodegraphRunState, full: CodegraphRunState, which: Ablation): void {
  const wants = (family: Ablation): boolean => which === "all" || which === family;
  // The three `types` halves are handed over separately because they cost very
  // different amounts to persist and, as it turned out, buy very different
  // amounts: `structuredReturnTypes` is keyed per METHOD (6518 entries on
  // taxdome, 111 edges), `returnTypes` per function name (2597, 20 edges), and
  // `ivarTypes` per CLASS — the cheapest of the three and worth nothing, though
  // only because taxdome's map is EMPTY (no type source emits `kind:"ivar"`
  // there, bd wr7ku). Re-run `--ablate ivar` on an ivar-annotated corpus before
  // reading that zero as a verdict on the map itself.
  if (wants("types") || wants("sret")) {
    Object.assign(inc.structuredReturnTypes, full.structuredReturnTypes);
  }
  if (wants("types") || wants("fret")) {
    Object.assign(inc.returnTypes, full.returnTypes);
  }
  if (wants("types") || wants("ivar")) {
    Object.assign(inc.ivarTypes, full.ivarTypes);
  }
  if (wants("rta")) {
    for (const t of full.instantiatedTypes) inc.instantiatedTypes.add(t);
  }
  if (wants("dispatch")) {
    Object.assign(inc.dispatchTables, full.dispatchTables);
    Object.assign(inc.callbackParams, full.callbackParams);
  }
  if (wants("params")) {
    Object.assign(inc.paramNames, full.paramNames);
    Object.assign(inc.paramTypes, full.paramTypes);
    Object.assign(inc.classFieldParamLinks, full.classFieldParamLinks);
    Object.assign(inc.derivedClassFieldTypes, full.derivedClassFieldTypes);
  }
  // Per CLASS KEY rather than per field: top-level assign is the right grain for
  // a MEASUREMENT, because both sides walked the same working tree and a key the
  // batch wrote holds the same fields the full run wrote for it. The persistence
  // this measures owes a batch-wins guard; an ablation does not.
  if (wants("cft")) {
    Object.assign(inc.classFieldTypesByClassKey, full.classFieldTypesByClassKey);
  }
  // Keyed by the DECLARING relPath, so the assign grain is already the grain the
  // channel is replaced at on a re-walk.
  if (wants("reexp")) {
    Object.assign(inc.moduleReexports, full.moduleReexports);
  }
}

function flag(name: string, fallback: string | undefined): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main(): Promise<void> {
  const corpus = flag("--corpus", undefined);
  if (corpus === undefined) {
    process.stderr.write("--corpus <abs path> is required\n");
    process.exit(1);
  }
  const root = resolvePath(corpus);
  const language = (flag("--language", "ruby") ?? "ruby") as HarnessLanguage;
  if (!LANGUAGES.includes(language)) {
    process.stderr.write(`--language must be one of ${LANGUAGES.join(", ")}\n`);
    process.exit(1);
  }
  const batches = Number(flag("--batches", "4"));
  const batchSize = Number(flag("--batch-size", "40"));
  const limit = Number(flag("--limit", String(Number.MAX_SAFE_INTEGER)));
  const jsonOut = flag("--json", undefined);
  const ablation = (flag("--ablate", "none") ?? "none") as Ablation;
  if (!ABLATIONS.includes(ablation)) {
    process.stderr.write(`--ablate must be one of ${ABLATIONS.join(", ")}\n`);
    process.exit(1);
  }

  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const extensions = extensionsFor(language);
  const selection = await collectSourceFiles(root, root, await buildCorpusExclusionFilter(root, factory), extensions);
  const files = selection.kept.slice(0, limit);
  // Read ONCE per corpus and handed to every extraction, exactly as production
  // reads it once per run before the walk (`extractFileBatch`).
  const declaredDependencies = readCorpusDeclaredDependencies(root, factory);
  process.stdout.write(
    `corpus ${root}\n  ${files.length} ${language} files kept ` +
      `(${selection.ingestIgnored} ingest-ignored, ${selection.codegraphExcluded} codegraph-excluded) ` +
      `· extensions ${extensions.join(",")} · declared deps ${declaredDependencies?.size ?? "none"}\n`,
  );

  // ── Phase 1: full walk. Symbol table + full run-global state + the pass-1
  //    slices an incremental run would read back. Extractions are discarded as
  //    we go; the batch files are re-extracted below (cheap, and it keeps peak
  //    memory proportional to the corpus's SYMBOLS, not its ASTs).
  const symbolTable = new InMemoryGlobalSymbolTable();
  // The FULL pass is ONE run, so it gets ONE view for the whole sweep; each
  // incremental batch is its own run and gets its own below. See
  // {@link symbolTableView} for why the identity, not the data, is what matters.
  const fullTable = symbolTableView(symbolTable);
  const fullState = newRunState(factory);
  bindRunStart(fullState, root);
  const slices: CodegraphPass1FileAggregates[] = [];
  let walked = 0;
  let parseFailures = 0;
  for (const relPath of files) {
    const extraction = extractFile(root, relPath, composer, factory, declaredDependencies);
    if (extraction === null) {
      parseFailures += 1;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    const selfDispatch = selfDispatchFor(extraction);
    fullState.absorb(extraction, selfDispatch);
    const slice = buildPass1Aggregates(extraction, selfDispatch);
    if (slice !== undefined) slices.push(slice);
    walked += 1;
  }
  await fullState.seal(async () => fullTable);
  process.stdout.write(
    `walked ${walked} (${parseFailures} unparseable) · pass-1 slices ${slices.length} · ` +
      `self-dispatch methods ${fullState.selfDispatchMethods.length} · templates ${Object.keys(fullState.selfDispatchTemplates).length}\n`,
  );
  // The COST side of the trade-off this bead weighs: how many entries each
  // candidate map would add to the persisted slice, against the ancestry keys
  // it already carries. A per-METHOD map is the objection; these are the
  // numbers that say how big it actually is on a real corpus.
  const cftKeys = Object.keys(fullState.classFieldTypesByClassKey);
  const cftFields = cftKeys.reduce((n, k) => n + Object.keys(fullState.classFieldTypesByClassKey[k]).length, 0);
  const reexpFiles = Object.keys(fullState.moduleReexports);
  const reexpEntries = reexpFiles.reduce((n, k) => n + fullState.moduleReexports[k].length, 0);
  process.stdout.write(
    `run-global map sizes — structuredReturnTypes ${Object.keys(fullState.structuredReturnTypes).length} (per method) · ` +
      `returnTypes ${Object.keys(fullState.returnTypes).length} (per function name) · ` +
      `ivarTypes ${Object.keys(fullState.ivarTypes).length} (per class) · ` +
      `classFieldTypesByClassKey ${cftKeys.length} keys / ${cftFields} fields (per class key) · ` +
      `moduleReexports ${reexpFiles.length} files / ${reexpEntries} entries (per declaring file) · ` +
      `ancestors ${Object.keys(fullState.ancestors).length} (per class, already persisted)\n`,
  );

  // ── Phase 2: batches — contiguous windows at evenly spaced offsets.
  const stride = Math.max(1, Math.floor(files.length / batches));
  const windows: RelPath[][] = [];
  for (let b = 0; b < batches; b++) {
    const start = Math.min(b * stride, Math.max(0, files.length - batchSize));
    windows.push(files.slice(start, start + batchSize));
  }

  const fullTotals = emptyKinds();
  const incTotals = emptyKinds();
  const edgeTotals = emptyEdgeDiff();
  const fullRunner = new CallEdgeResolutionRunner(factory, fullState);

  for (const [i, window] of windows.entries()) {
    const extractions: FileExtraction[] = [];
    for (const relPath of window) {
      const e = extractFile(root, relPath, composer, factory, declaredDependencies);
      if (e !== null) extractions.push(e);
    }

    // FULL side — resolve against the state that absorbed every file.
    const before = snapshotKinds(fullState, language);
    const fullAnswers: CallSiteAnswers = new Map();
    for (const e of extractions) indexCallEdges(e.relPath, fullRunner.resolve(e, fullTable), fullAnswers);
    addInto(fullTotals, subtractKinds(snapshotKinds(fullState, language), before));

    // INC side — a fresh run that walked ONLY this window, with the rest
    // hydrated from the persisted slices exactly as production does.
    const incTable = symbolTableView(symbolTable);
    const incState = newRunState(factory);
    bindRunStart(incState, root);
    for (const e of extractions) incState.absorb(e, selfDispatchFor(e));
    await incState.seal(
      async () => incTable,
      async () => slices,
    );
    ablate(incState, fullState, ablation);
    const incRunner = new CallEdgeResolutionRunner(factory, incState);
    const incAnswers: CallSiteAnswers = new Map();
    for (const e of extractions) indexCallEdges(e.relPath, incRunner.resolve(e, incTable), incAnswers);
    addInto(incTotals, snapshotKinds(incState, language));
    addEdgeDiff(edgeTotals, diffCallEdges(fullAnswers, incAnswers));

    process.stdout.write(`  batch ${i + 1}/${windows.length}: ${extractions.length} files\n`);
  }

  // ── Report.
  const rows: string[] = [];
  let attemptedAll = 0;
  let lostAll = 0;
  for (const kind of RECEIVER_KINDS) {
    const f = fullTotals[kind];
    const n = incTotals[kind];
    if (f.attempted === 0 && n.attempted === 0) continue;
    attemptedAll += f.attempted;
    lostAll += f.resolved - n.resolved;
    rows.push(
      `  ${kind.padEnd(11)} attempted ${String(f.attempted).padStart(6)}` +
        `  full ${rate(f).toFixed(4)} ${String(f.resolved).padStart(6)}` +
        `  inc ${rate(n).toFixed(4)} ${String(n.resolved).padStart(6)}` +
        `  Δresolved ${(n.resolved - f.resolved).toString().padStart(5)}${
          f.unnarrowedTemplate !== n.unnarrowedTemplate
            ? `  Δunnarrowed ${(n.unnarrowedTemplate - f.unnarrowedTemplate).toString().padStart(4)}`
            : ""
        }`,
    );
  }
  process.stdout.write(
    `\n${language} · per receiver kind — FULL (every file absorbed) vs INC (batch + hydrated pass-1 slices` +
      `${ablation === "none" ? "" : ` + ablated ${ablation}`})\n${rows.join("\n")}\n` +
      `\ntotal: ${attemptedAll} calls attempted across ${windows.length} batches · ` +
      `${lostAll} edge(s) lost by the incremental run ` +
      `(${attemptedAll === 0 ? "0.00" : ((lostAll / attemptedAll) * 100).toFixed(2)}% of attempts)\n`,
  );
  const kindBreakdown = (bucket: Record<string, number>): string => {
    const parts = Object.entries(bucket).sort(([, a], [, b]) => b - a);
    return parts.length === 0 ? "—" : parts.map(([k, n]) => `${k} ${n}`).join(", ");
  };
  process.stdout.write(
    `\ncall-edge set diff — keyed by (caller relPath, caller symbolId, call expression)\n` +
      `  full ${edgeTotals.fullEdges} edges over ${edgeTotals.fullSites} sites · ` +
      `inc ${edgeTotals.incEdges} edges over ${edgeTotals.incSites} sites · ` +
      `${edgeTotals.sharedSites} shared sites\n` +
      `  lost ${edgeTotals.lost} · phantom ${edgeTotals.phantom} · retargeted ${edgeTotals.retargeted}\n` +
      `  missing by edgeKind: ${kindBreakdown(edgeTotals.missingByKind)}\n` +
      `  extra   by edgeKind: ${kindBreakdown(edgeTotals.extraByKind)}\n`,
  );

  if (jsonOut !== undefined) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          corpus: root,
          language,
          ablation,
          files: files.length,
          ingestIgnored: selection.ingestIgnored,
          codegraphExcluded: selection.codegraphExcluded,
          windows: windows.map((w) => w.length),
          mapSizes: {
            structuredReturnTypes: Object.keys(fullState.structuredReturnTypes).length,
            returnTypes: Object.keys(fullState.returnTypes).length,
            ivarTypes: Object.keys(fullState.ivarTypes).length,
            classFieldTypesByClassKeyKeys: cftKeys.length,
            classFieldTypesByClassKeyFields: cftFields,
            moduleReexportsFiles: reexpFiles.length,
            moduleReexportsEntries: reexpEntries,
            ancestors: Object.keys(fullState.ancestors).length,
          },
          fullTotals,
          incTotals,
          edgeDiff: edgeTotals,
        },
        null,
        2,
      ),
    );
    process.stdout.write(`wrote ${jsonOut}\n`);
  }
}

await main();
