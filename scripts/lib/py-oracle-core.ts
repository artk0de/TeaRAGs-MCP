/**
 * Pure core for the Python codegraph oracle (bd tea-rags-mcp-xumwz).
 *
 * The shared verdicts, the diff and the tally come from
 * `ts-codegraph-typechecker-oracle.ts` by IMPORT — its `main` is guarded by
 * `import.meta.url === file://argv[1]`, so importing the module runs nothing and
 * there is no reason to relocate or copy it. What lives here is only what
 * Python adds: two extra verdicts, an origin vocabulary with a venv in it, the
 * missed-shape categories, degraded-row handling, and seeded sampling.
 *
 * Everything is a pure function over in-memory values. The harness owns the
 * corpus, the subprocess and the clock.
 */
import type { CallContext, CallRef, DispatchFanoutOutcome } from "../../src/core/contracts/types/codegraph.js";
import {
  diffResolution,
  tallyBy,
  type OracleAnswer,
  type OracleOutcome,
  type OracleRow,
  type OracleTally,
  type OracleVerdict,
} from "../ts-codegraph-typechecker-oracle.js";

export type PyOracleVerdict = OracleVerdict | "skippedInProject" | "parseFailed" | "oracleNonCallable";

export type PyTargetOrigin =
  | "project"
  | "generatedInRepo"
  | "sitePackages"
  | "stdlib"
  | "builtin"
  | "typeshedStub"
  | "outsideRepo";

export const PY_MISSED_CATEGORIES = [
  "annotationParam",
  "annotationReturn",
  "reexport",
  "starImport",
  "superMro",
  "decoratorProperty",
  "managerQuerySet",
  "dependsInjection",
  "unionReceiver",
  "plain",
] as const;
export type PyMissedCategory = (typeof PY_MISSED_CATEGORIES)[number];

export const PY_UNLOCATED_SHAPES = ["decoratorBare", "multiLineCall", "subscriptCall", "coordinateMiss"] as const;
export type PyUnlocatedShape = (typeof PY_UNLOCATED_SHAPES)[number];

export interface PySiteFacts {
  receiverIsAnnotatedParam: boolean;
  enclosingHasReturnAnnotation: boolean;
  viaReexport: boolean;
  viaStarImport: boolean;
  isSuperCall: boolean;
  targetIsProperty: boolean;
  targetIsStaticOrClassMethod: boolean;
  receiverIsUnion: boolean;
  isDecoratorSite: boolean;
}

/**
 * Which engine produced a reply (bd tea-rags-mcp-w205u, E4.0.2).
 *
 * `lsp` is named for the TRANSPORT, not for the engine behind it: both second
 * oracle candidates speak LSP, so swapping pyright for another one is a
 * launcher record rather than a new vocabulary term.
 */
export type OracleEngine = "jedi" | "lsp";
export type OracleSelection = OracleEngine | "merged";

/**
 * What the dispatch layer emitted at a call site (bd tea-rags-mcp-w205u, E4.0.3).
 *
 * Four outcomes, not the three the plan sketched, because the runner's default
 * channel splits a non-empty fan-out by SIZE and the two halves are different
 * products. One surviving target is a confidence-1 edge that REPLACES the exact
 * chain's answer — a 1:1 claim governed by the 1:1 precision bar, so it is
 * scored in the 1:1 columns. Two or more is a hypothesis set carrying
 * `discount / m`, scored only in the fan columns (D3). `ambiguous` is the
 * DECISION not to fan at all: no edges, no fallback, and
 * `resolveDispatchViaComponents` treats it as decisive.
 */
export type PyFanOutcomeKind = "none" | "single" | "fan" | "ambiguous";

/** One dispatch target, structured — what a `single` outcome books as the 1:1 answer. */
export interface PyFanTarget {
  targetRelPath: string;
  targetSymbolId: string | null;
}

export interface PyFanOutcome {
  kind: PyFanOutcomeKind;
  /** `${targetRelPath}#${targetSymbolId ?? ""}`, sorted, deduped. Empty for `none` / `ambiguous`. */
  fan: string[];
  /** `fan.length` for `single` / `fan`; `candidateCount` for `ambiguous`; 0 for `none`. */
  fanSize: number;
  /** The per-edge confidence the component assigned; null when there are no edges. */
  fanConfidence: number | null;
  /** The one target a `single` outcome pins. null for every other kind. */
  single: PyFanTarget | null;
}

export const NO_FAN: PyFanOutcome = { kind: "none", fan: [], fanSize: 0, fanConfidence: null, single: null };

/** A row's dispatch outcome plus the oracle comparison the fan columns need. */
export interface PyFanScore extends PyFanOutcome {
  /** The oracle's in-project target is in `fan` (file+symbol; file only on `pinUncertain`). */
  hitsOracle: boolean;
  /** The oracle had an in-project target at all — the fan denominator's gate. */
  oracleInProject: boolean;
}

/**
 * What `resolveDispatch` would emit at this site (bd tea-rags-mcp-w205u).
 *
 * NOT summed with the exact chain, ever: a fan edge is a hypothesis set hidden
 * from navigation, and its quality bar is `precisionProxy`, not the phantom
 * rate. Dedup runs BEFORE the size split, so m edges that name one target are
 * booked `single` — production persists both edges, but a 1:1 comparison has
 * one answer to compare and calling that a fan would inflate `fanSites`.
 */
export function scoreFan(
  resolver: { resolveDispatch?: (call: CallRef, ctx: CallContext) => DispatchFanoutOutcome },
  call: CallRef,
  ctx: CallContext,
): PyFanOutcome {
  const outcome = resolver.resolveDispatch?.(call, ctx);
  if (outcome === undefined) return NO_FAN;
  if (outcome.kind === "ambiguous") {
    return { kind: "ambiguous", fan: [], fanSize: outcome.candidateCount, fanConfidence: null, single: null };
  }
  if (outcome.edges.length === 0) return NO_FAN;
  const byKey = new Map<string, PyFanTarget>();
  for (const edge of outcome.edges) {
    const key = `${edge.targetRelPath}#${edge.targetSymbolId ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, { targetRelPath: edge.targetRelPath, targetSymbolId: edge.targetSymbolId ?? null });
    }
  }
  const fan = [...byKey.keys()].sort();
  const fanConfidence = outcome.edges[0]?.confidence ?? null;
  return fan.length === 1
    ? { kind: "single", fan, fanSize: 1, fanConfidence, single: byKey.get(fan[0]) ?? null }
    : { kind: "fan", fan, fanSize: fan.length, fanConfidence, single: null };
}

/** One answer, in the shape BOTH engines emit. Schema identity is the contract. */
export interface PyOracleAnswer {
  startLine: number;
  member: string;
  outcome: {
    kind: "inProject" | "external" | "unknown" | "parseFailed";
    origin?: PyTargetOrigin;
    targets?: {
      relPath: string;
      symbolId: string | null;
      defLine?: number;
      defKind?: string;
      /**
       * What the COMPOSER found at the target line, unmasked by jedi's own
       * `name.type`. `nonCallable` says the line holds an assignment rather
       * than a `def`/`class`, which is the whole of the `oracleNonCallable`
       * bucket; `unknown` says the target file could not be parsed at all.
       */
      defNodeKind?: string;
      pinUncertain: boolean;
    }[];
  };
  /**
   * PARTIAL on purpose. jedi answers every key; an engine with no AST of the
   * caller cannot, and an absent fact is not a false one — `categorizePySite`
   * reads each with `=== true`, so omitting is the honest encoding and guessing
   * would invent shape categories nobody measured.
   */
  siteFacts?: Partial<PySiteFacts>;
  unlocated?: PyUnlocatedShape;
}

export interface PyOracleFileReply {
  relPath: string;
  parseFailed: boolean;
  /**
   * How many errors JEDI's parser reported. Always 0 from an engine with no
   * jedi in it — the field means "jedi's parser was unhappy", and the merge
   * reads it from the JEDI reply only.
   */
  parsoErrors: number;
  answers: PyOracleAnswer[];
}

/** One file's reply plus the provenance the report splits every table by. */
export interface MergedOracleFileReply {
  reply: PyOracleFileReply;
  engine: OracleEngine;
  /**
   * What JEDI said about this file, kept whenever the merge did not use it.
   * Present on every entry of a run that asked jedi at all, so the legacy side
   * of the report can rebuild the row a `--oracle jedi` run would have produced
   * — a degraded row counts in `sites` and is withheld from the rates, and
   * dropping it shrank the published `sites` column (bd tea-rags-mcp-w205u).
   * Absent under `--oracle lsp`, where jedi was never asked and there is no
   * legacy population to reproduce.
   */
  legacy?: PyOracleFileReply;
}

export interface PyOracleRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind: string;
  categories: PyMissedCategory[];
  verdict: PyOracleVerdict;
  answeredBy: string;
  chainOutput: "pinned" | "fileOnly" | "none";
  chain?: OracleAnswer;
  origin?: PyTargetOrigin;
  oracleDegraded: boolean;
  unlocatedShape?: PyUnlocatedShape;
  /** Which engine answered THIS row's file. Defaults to `jedi`, the primary. */
  oracleEngine: OracleEngine;
  /**
   * What the dispatch layer emitted here (bd tea-rags-mcp-w205u, E4.0.3).
   *
   * ABSENT under `--no-dispatch` and on every row a pre-E4.0.3 driver built,
   * which is what keeps the 1:1 columns byte-identical: an absent field is not
   * a `none` outcome measured, it is a layer never run.
   */
  dispatch?: PyFanScore;
  /**
   * The verdict the EXACT chain would have earned, present ONLY where the
   * dispatch layer replaced its answer (a `fan` or `ambiguous` outcome). It is
   * what makes `exactReplacedByFan` readable off one run instead of a per-site
   * join between two.
   */
  exactVerdict?: PyOracleVerdict;
  /** The exact chain's own output at a replaced site — `none` says it had no answer. */
  exactChainOutput?: "pinned" | "fileOnly" | "none";
  /**
   * The row a `--oracle jedi` run would have produced for this same site, set
   * only when the merge answered the file from the second engine. Read it
   * through `legacyViewOf`, never directly: on a row jedi answered the legacy
   * view IS the row, and the two cases must not be spelled differently at every
   * call site.
   */
  legacy?: PyOracleRow;
}

/**
 * The row the legacy (jedi) side of the report counts for this site.
 *
 * `undefined` means the run never asked jedi about the file — `--oracle lsp`,
 * where `recallLegacy` reads 0/0 by construction. Everything else has a legacy
 * row, including a file jedi stayed silent about: silence is an answer a
 * jedi-only run books as `bothUnresolved`, not a site that disappears.
 */
export function legacyViewOf(row: PyOracleRow): PyOracleRow | undefined {
  return row.oracleEngine === "jedi" ? row : row.legacy;
}

/**
 * Per FILE, never per site (bd tea-rags-mcp-w205u).
 *
 * jedi is primary: five corpora of published numbers rest on it, and its blind
 * spots are hand-audited (`applySuperMroBlindSpot`, `oracleNonCallable`). The
 * second engine is a REPAIR for files jedi could not read — `parsoErrors > 0`
 * means jedi answered from a damaged tree, `parseFailed` means it had no tree
 * at all — and never a tiebreak on a file jedi read cleanly.
 *
 * File granularity is not a simplification: jedi's per-process module cache
 * makes one file's answer depend on what its worker parsed before it
 * (`jedi_oracle.py:539`), so a per-SITE mix would put two module resolutions
 * behind one `jedi.Script` cache and make row-level provenance unreadable.
 */
export function mergeOracleReplies(
  jedi: ReadonlyMap<string, PyOracleFileReply>,
  lsp: ReadonlyMap<string, PyOracleFileReply>,
): Map<string, MergedOracleFileReply> {
  const merged = new Map<string, MergedOracleFileReply>();
  for (const [relPath, reply] of jedi) {
    const damaged = reply.parseFailed || reply.parsoErrors > 0;
    const replacement = damaged ? lsp.get(relPath) : undefined;
    merged.set(
      relPath,
      replacement === undefined ? { reply, engine: "jedi" } : { reply: replacement, engine: "lsp", legacy: reply },
    );
  }
  // A file only the second engine saw (jedi's launcher skipped it, or its
  // worker died) still belongs in the population — dropping it would shrink the
  // denominator silently, which is the failure this whole task exists to end.
  // Its legacy reply is jedi's SILENCE spelled out, which is what a jedi-only
  // run reads for the file: no answers, no parse failure, no parso errors.
  for (const [relPath, reply] of lsp) {
    if (!merged.has(relPath)) {
      merged.set(relPath, {
        reply,
        engine: "lsp",
        legacy: { relPath, parseFailed: false, parsoErrors: 0, answers: [] },
      });
    }
  }
  return merged;
}

/**
 * Read a reply map entry whichever shape it arrives in.
 *
 * The scratch row drivers hand `buildRows` a plain `Map<relPath, reply>` and
 * must keep working byte-for-byte under `--oracle jedi`, while `main` hands it
 * the merged map. `PyOracleFileReply` has no `reply` key, so the discrimination
 * is exact rather than a guess.
 */
export function oracleEntryOf(value: PyOracleFileReply | MergedOracleFileReply | undefined): {
  reply: PyOracleFileReply | undefined;
  engine: OracleEngine;
  legacy?: PyOracleFileReply;
} {
  if (value === undefined) return { reply: undefined, engine: "jedi" };
  return "reply" in value ? value : { reply: value, engine: "jedi" };
}

/**
 * One call site's verdict.
 *
 * `parseFailed` wins outright: with no AST there is no ground truth, and any
 * other bucket would be an opinion about a file nobody read.
 *
 * `oracleNonCallable` comes next and for the same reason, one step narrower:
 * the file parsed, jedi answered in-project, and the line it pointed at holds
 * no `def` or `class` — a class attribute (`table = None` called as
 * `self.table(...)`) or a local name bound to a callable. There is no callable
 * definition at that target, so nothing the chain could have emitted would
 * match it, and every comparison it takes part in is an artefact of WHERE the
 * binding happens to live: the chain's correct answer reads `wrongFile`
 * against the caller's own file, a decline reads `missed`, and an answer in
 * the binding's file reads `match` on a symbol id the host substituted from
 * the chain itself. Measured on netbox: 280 rows, 242 of them booked `missed`.
 * The bucket is kept OUT of `missed` and out of every rate — `missed` asks for
 * a resolution strategy, and no strategy fixes a target that is not a
 * definition. It also outranks `skippedInProject`, which asserts jedi found a
 * definition the classifier waved off; here jedi found no definition at all.
 *
 * `skippedInProject` is the classifier's own precision defect — it declared
 * the site external and jedi found the definition inside the project — and it
 * is kept OUT of `missed` because the two point at different fixes: `missed`
 * asks for a strategy, `skippedInProject` asks for a narrower vocabulary.
 */
export function classifyPyVerdict(input: {
  chain: OracleAnswer | null;
  oracle: OracleOutcome;
  parseFailed: boolean;
  classifiedExternal: boolean;
  /** jedi's in-project target is an assignment, not a `def`/`class`. */
  oracleTargetNonCallable: boolean;
}): PyOracleVerdict {
  if (input.parseFailed) return "parseFailed";
  if (input.oracleTargetNonCallable && input.oracle.kind === "inProject") return "oracleNonCallable";
  if (input.classifiedExternal && input.oracle.kind === "inProject") return "skippedInProject";
  return diffResolution(input.chain, input.oracle);
}

const MANAGER_RECEIVER_RE = /(^|\.)(objects|_default_manager|query|session)$/;
const QUERYSET_MEMBERS = new Set(["all", "filter", "exclude", "get", "annotate", "values", "first", "last", "count"]);
const INJECTION_MEMBERS = new Set(["Depends", "Security", "Provide", "inject"]);

/**
 * Which shapes a site exercises. A site can carry several: the axis overlaps by
 * construction — an annotated parameter can also be a union — and forcing a
 * precedence would attribute a site to whichever fact happened to be tested
 * first. `plain` is the residual and never appears beside another category.
 */
export function categorizePySite(
  facts: Partial<PySiteFacts> | undefined,
  row: { receiver: string | null; member: string },
): PyMissedCategory[] {
  const found = new Set<PyMissedCategory>();
  if (facts?.receiverIsAnnotatedParam === true) found.add("annotationParam");
  if (facts?.enclosingHasReturnAnnotation === true) found.add("annotationReturn");
  if (facts?.viaReexport === true) found.add("reexport");
  if (facts?.viaStarImport === true) found.add("starImport");
  if (facts?.isSuperCall === true) found.add("superMro");
  if (facts?.targetIsProperty === true || facts?.targetIsStaticOrClassMethod === true) found.add("decoratorProperty");
  if (facts?.receiverIsUnion === true) found.add("unionReceiver");
  const receiver = row.receiver ?? "";
  if (MANAGER_RECEIVER_RE.test(receiver) && QUERYSET_MEMBERS.has(row.member)) found.add("managerQuerySet");
  if (INJECTION_MEMBERS.has(row.member)) found.add("dependsInjection");
  return found.size === 0 ? ["plain"] : [...found].sort();
}

/**
 * Is this call site a `super(...)` dispatch?
 *
 * `receiverKind` alone does NOT answer it on Python. `SUPER_MARKERS` holds
 * `"super"` and `"<super>"`, but the Python walker emits the receiver of
 * `super().__init__(name)` as the text `"super()"`, so `classifyReceiverKind`
 * files these sites under `dynamic`. Measured on the fixture corpus: all four
 * `super()` records in `pkg/models.py` come back `dynamic`, none `super`. A
 * predicate keyed on the receiver kind alone would therefore be dead code.
 *
 * So three signals, any of which is sufficient: the classifier's own marker
 * (other languages and the `<super>` spelling reach it), the Python side's
 * measured `isSuperCall`, and the receiver text itself.
 */
export function isSuperCallSite(input: {
  receiverKind: string;
  receiver: string | null;
  facts: Partial<PySiteFacts> | undefined;
}): boolean {
  if (input.receiverKind === "super") return true;
  if (input.facts?.isSuperCall === true) return true;
  return input.receiver !== null && /^super\s*\(/.test(input.receiver);
}

/**
 * The four origins that put jedi's target OUTSIDE the project. `outsideRepo`
 * and `generatedInRepo` are deliberately absent: the first is a path the corpus
 * manifest placed off the scored tree rather than a library boundary, and the
 * second is in-repo code the chain is expected to resolve.
 */
const EXTERNAL_TARGET_ORIGINS: ReadonlySet<PyTargetOrigin> = new Set([
  "sitePackages",
  "stdlib",
  "typeshedStub",
  "builtin",
]);

/**
 * Withdraw jedi's answer where jedi is known to be wrong about `super()`.
 *
 * Measured on the fixture corpus while building the Python side: jedi 0.20.0
 * walks a `super()` call through the FIRST base only. On
 * `class User(Auditable, Named)` where only `Named` defines `__init__`,
 * `super().__init__` answers `object.__init__` out of jedi's bundled typeshed —
 * a stub for a method the runtime MRO never reaches. That row carries no ground
 * truth, so it is mapped to `unknown` and lands in `chainOnly` /
 * `bothUnresolved`, outside every rate. Scoring it as written would do real
 * damage in both directions: a chain that correctly resolved the call through
 * the second base would be booked as a `phantom`, and a chain that declined
 * would earn an `agreeExternal` it did not deserve.
 *
 * The typeshed origin was the whole guard until the walker started filing
 * `super()` receivers under receiverKind `super`, and the netbox rows then made
 * the rest of the blind spot visible: 65 sites where jedi's first base is a
 * LIBRARY class rather than a typeshed stub, 45 of them booked as `phantom`
 * against a chain that was right. `DataSource(JobsMixin, PrimaryModel).save`
 * lands in django (`origin: sitePackages`) while the C3 MRO reaches
 * `BaseModel#save`; `Circuit(…, DistanceMixin, PrimaryModel).clean` the same
 * way. Both chain answers were hand-verified. So the gate is ARITY: more than
 * one declared base is exactly the condition under which "first base" stops
 * being "the MRO", and under it any external origin is withdrawn.
 *
 * What is still compared, on purpose:
 *   - a jedi target INSIDE the project — that is a real answer whatever the
 *     class's arity, and the chain has to match it;
 *   - a single-base enclosing class — there jedi's walk IS the MRO, so an
 *     external answer is ground truth and a chain that misses it is a phantom.
 *
 * `typeshedStub` stays unconditional, base count or not: a `super()` site
 * answered from a stub is the `object.__init__` shape that started this, and
 * the arity gate only WIDENS the guard rather than re-opening what it held.
 *
 * `superMro` is tagged on every withdrawal, so the sites lost to the blind spot
 * stay countable.
 */
export function applySuperMroBlindSpot(input: {
  isSuperCall: boolean;
  origin: PyTargetOrigin | undefined;
  oracle: OracleOutcome;
  categories: readonly PyMissedCategory[];
  /**
   * How many bases the site's enclosing class declares, `undefined` when the
   * site has no enclosing class (or the run carries no `classAncestors`).
   * Absent or `<= 1` keeps every non-typeshed answer.
   */
  enclosingBaseCount?: number;
}): { oracle: OracleOutcome; categories: PyMissedCategory[] } {
  const keep = { oracle: input.oracle, categories: [...input.categories] };
  if (!input.isSuperCall) return keep;
  if (input.origin === undefined || !EXTERNAL_TARGET_ORIGINS.has(input.origin)) return keep;
  if (input.origin !== "typeshedStub" && (input.enclosingBaseCount ?? 0) <= 1) return keep;
  const categories = [...new Set<PyMissedCategory>([...input.categories, "superMro"])]
    .filter((category) => category !== "plain")
    .sort();
  return { oracle: { kind: "unknown" }, categories };
}

/** A zeroed tally, so a label seen only on withheld rows still gets a row. */
function emptyTally(label: string): OracleTally {
  return {
    label,
    sites: 0,
    oracle: 0,
    match: 0,
    fileOnly: 0,
    wrongFile: 0,
    missed: 0,
    external: 0,
    phantom: 0,
    agreeExternal: 0,
    chainOnly: 0,
    bothUnresolved: 0,
    mismatchRate: 0,
    phantomRate: 0,
  };
}

/**
 * A row carrying no 1:1 verdict: counted in `sites`, withheld from every rate.
 *
 * Four populations, one predicate, because the tally treats them identically —
 * a degraded parse, a file with no AST at all, an in-project answer whose target
 * is not a definition, and (under `--dispatch`) a site where the fan-out
 * replaced the exact answer with a hypothesis set or threw it away over the cap.
 * What they share is that no 1:1 verdict about the CHAIN can be read off them:
 * production emitted no single edge there, so scoring one would compare against
 * an answer nothing published. Those rows are scored in the FAN columns instead
 * (D3), and the field is absent entirely under `--no-dispatch`.
 */
function isWithheldFromRates(row: PyOracleRow): boolean {
  return (
    row.dispatch?.kind === "fan" ||
    row.dispatch?.kind === "ambiguous" ||
    row.oracleDegraded ||
    row.verdict === "parseFailed" ||
    row.verdict === "oracleNonCallable"
  );
}

/**
 * The shared `OracleVerdict` a SCORED row carries.
 *
 * `skippedInProject` folds into `missed` — a miss the classifier caused belongs
 * in the recall numerator, so a vocabulary that over-claims cannot buy a better
 * rate by moving sites out of `missed`. The other two Python-only verdicts are
 * withheld before any row reaches here, and the throw states that invariant
 * outright: it used to ride on TypeScript INFERRING a type predicate from
 * `isWithheldFromRates`, which the fan clauses quietly cost (the predicate can
 * narrow one field, not two).
 */
function toScoredVerdict(verdict: PyOracleVerdict): OracleVerdict {
  if (verdict === "skippedInProject") return "missed";
  if (verdict === "parseFailed" || verdict === "oracleNonCallable") {
    throw new Error(`a verdict withheld from the rates reached the scored tally: ${verdict}`);
  }
  return verdict;
}

/**
 * Aggregate rows under every label they carry.
 *
 * Degraded rows are counted in `sites` and then withheld from the rate
 * denominators. Dropping them would hide how much of a corpus jedi could not
 * read (polar: ~7.6% of files); counting them would let a stale parso grammar
 * masquerade as a resolver defect. Both failures were possible before this
 * split, and the second is the one that would have been believed.
 */
export function tallyPyRows(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): OracleTally[] {
  // A WeakMap from the mapped row back to its source, so `tallyBy`'s label
  // callback keeps seeing the Python row without an O(n²) `indexOf` bridge.
  const source = new WeakMap<OracleRow, PyOracleRow>();
  const scored: OracleRow[] = [];
  for (const row of rows) {
    if (isWithheldFromRates(row)) continue;
    const mapped: OracleRow = {
      relPath: row.relPath,
      startLine: row.startLine,
      callText: row.callText,
      receiverKind: row.receiverKind,
      categories: [...row.categories],
      verdict: toScoredVerdict(row.verdict),
      chainOutput: row.chainOutput,
    };
    source.set(mapped, row);
    scored.push(mapped);
  }
  const shared = tallyBy(scored, (mapped) => {
    const origin = source.get(mapped);
    return origin === undefined ? [] : labelsOf(origin);
  });

  // Sites the shared tally never saw still need their count, or the report's
  // `sites` column stops summing to the corpus.
  const bySite = new Map(shared.map((tally) => [tally.label, tally]));
  for (const row of rows) {
    if (!isWithheldFromRates(row)) continue;
    for (const label of labelsOf(row)) {
      let tally = bySite.get(label);
      if (tally === undefined) {
        tally = emptyTally(label);
        bySite.set(label, tally);
      }
      tally.sites += 1;
    }
  }
  return [...bySite.values()].sort((a, b) => b.sites - a.sites || a.label.localeCompare(b.label));
}

/** The counts the per-label tally cannot carry. */
export interface PyCoverageCounts {
  skippedInProject: number;
  parseFailed: number;
  oracleNonCallable: number;
  unlocated: number;
  unlocatedByShape: Partial<Record<PyUnlocatedShape, number>>;
}

/**
 * Count what `tallyPyRows` folds away.
 *
 * `skippedInProject` is deliberately merged into `missed` there while
 * `parseFailed` and `oracleNonCallable` rows are dropped from the rates
 * entirely, which leaves all three unreadable from the per-label rows — yet the
 * baseline reports the first as the precision floor, the second as a gap in the
 * instrument, and the third as the share of jedi answers that name a binding
 * rather than a definition. `unlocated` is a fourth population the tally never
 * sees at all: it is a site the oracle could not tie back to an AST node,
 * reported by SHAPE so the gap names its own fix. Shapes nobody hit are
 * omitted, and the map is built in the fixed `PY_UNLOCATED_SHAPES` order so two
 * runs serialize identically.
 */
export function tallyPyCoverage(rows: readonly PyOracleRow[]): PyCoverageCounts {
  const byShape = new Map<PyUnlocatedShape, number>();
  let skippedInProject = 0;
  let parseFailed = 0;
  let oracleNonCallable = 0;
  let unlocated = 0;
  for (const row of rows) {
    if (row.verdict === "skippedInProject") skippedInProject += 1;
    if (row.verdict === "parseFailed") parseFailed += 1;
    if (row.verdict === "oracleNonCallable") oracleNonCallable += 1;
    if (row.unlocatedShape === undefined) continue;
    unlocated += 1;
    byShape.set(row.unlocatedShape, (byShape.get(row.unlocatedShape) ?? 0) + 1);
  }
  const unlocatedByShape: Partial<Record<PyUnlocatedShape, number>> = {};
  for (const shape of PY_UNLOCATED_SHAPES) {
    const count = byShape.get(shape);
    if (count !== undefined) unlocatedByShape[shape] = count;
  }
  return { skippedInProject, parseFailed, oracleNonCallable, unlocated, unlocatedByShape };
}

/** Deterministic PRNG — the seed is a CLI flag so a sample can be reproduced. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` rows of one verdict, drawn at random rather than taken from the
 * front. First-N samples the corpus's directory order, which on every corpus
 * here means one package answering for the whole repo — the TS oracle's header
 * records the same lesson.
 */
export function samplePyRows(
  rows: readonly PyOracleRow[],
  verdict: PyOracleVerdict,
  count: number,
  seed: number,
): PyOracleRow[] {
  const pool = rows.filter((row) => row.verdict === verdict);
  if (pool.length <= count) return [...pool];
  const random = mulberry32(seed);
  const indexes = pool.map((_, index) => index);
  // Fisher-Yates over the INDEX list, so the draw depends only on the seed and
  // the pool size — not on row contents, which differ between corpora.
  for (let i = indexes.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((index) => pool[index]);
}

/**
 * Where the callee NAME starts on its line, so a second engine can be asked
 * about the right token (bd tea-rags-mcp-w205u, E4.0.2).
 *
 * `CallRef` carries a line and no column, and the spike's client re-derived one
 * by searching the line for the member name. On `asyncio.run(run())` that finds
 * the OUTER `run` for a record describing the inner one — one row of 500, but a
 * systematic bias toward the leftmost same-named callee, so D7 required the
 * host to send a column rather than let the engine invent one.
 *
 * `callText` is what breaks the tie: it is the call expression's own source, so
 * locating it first pins which occurrence the record means, and the member sits
 * at a known offset inside it (after `receiver.`, or at 0 for a free call).
 * `searchFrom` walks successive sites on one line past the occurrences already
 * claimed. The regex fallback is the spike's heuristic, kept for the shapes
 * `callText` cannot be found in — a call spanning several lines, or one the
 * walker normalised.
 */
export function locateCalleeColumn(
  lineText: string,
  site: { callText: string; receiver: string | null; member: string },
  searchFrom = 0,
): number {
  const offset =
    site.receiver !== null && site.callText.startsWith(`${site.receiver}.${site.member}`)
      ? site.receiver.length + 1
      : site.callText.startsWith(site.member)
        ? 0
        : -1;
  if (offset >= 0) {
    const at = lineText.indexOf(site.callText, searchFrom);
    if (at >= 0) return at + offset;
  }
  const escaped = site.member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = lineText.slice(searchFrom);
  const called = new RegExp(`(?<![A-Za-z0-9_])${escaped}\\s*[([]`).exec(tail);
  if (called !== null) return searchFrom + called.index;
  const bare = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).exec(tail);
  return bare === null ? -1 : searchFrom + bare.index;
}

/** The recall denominator is `match + fileOnly + wrongFile + missed` — `OracleTally#oracle`. */
const RECALL_VERDICTS: ReadonlySet<PyOracleVerdict> = new Set(["match", "fileOnly", "wrongFile", "missed"]);

/**
 * One label's recall under BOTH denominators (bd tea-rags-mcp-w205u).
 *
 * `recallLegacy` counts the rows the JEDI engine answered, degraded files
 * withheld from the rates exactly as a jedi-only run withholds them — so it
 * reproduces every published Python number byte-for-byte and is a REGRESSION
 * GATE rather than a migration aid. `recallMerged` counts every scored row
 * whatever engine answered it, and is what E4.1–E4.6 are measured against. The
 * two are printed side by side, always: adding the previously-degraded rows
 * moves every rate with no resolver change, and a number that moves for that
 * reason must never be readable as a regression.
 */
export interface PyRecallSplit {
  label: string;
  recallLegacy: number;
  nLegacy: number;
  matchLegacy: number;
  recallMerged: number;
  nMerged: number;
  matchMerged: number;
  /** Scored rows the second engine contributed — `nMerged - nLegacy`. */
  nSecondEngine: number;
}

export function tallyPyRecall(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): PyRecallSplit[] {
  const byLabel = new Map<string, PyRecallSplit>();
  const ensure = (label: string): PyRecallSplit => {
    let split = byLabel.get(label);
    if (split === undefined) {
      split = {
        label,
        recallLegacy: 0,
        nLegacy: 0,
        matchLegacy: 0,
        recallMerged: 0,
        nMerged: 0,
        matchMerged: 0,
        nSecondEngine: 0,
      };
      byLabel.set(label, split);
    }
    return split;
  };
  // `skippedInProject` folds into `missed` exactly as `tallyPyRows` folds it,
  // or the two blocks would disagree about the same rows. `null` is a row that
  // carries no ground truth about the chain at all.
  const scoredVerdict = (row: PyOracleRow | undefined): PyOracleVerdict | null => {
    if (row === undefined || isWithheldFromRates(row)) return null;
    const verdict = row.verdict === "skippedInProject" ? "missed" : row.verdict;
    return RECALL_VERDICTS.has(verdict) ? verdict : null;
  };
  for (const row of rows) {
    const merged = scoredVerdict(row);
    if (merged !== null) {
      for (const label of labelsOf(row)) {
        const split = ensure(label);
        split.nMerged += 1;
        if (merged === "match") split.matchMerged += 1;
      }
    }
    // The legacy side reads its OWN row: on a replaced file that is the row
    // jedi produced, degraded and therefore withheld, which is exactly what a
    // jedi-only run counts. Its labels come off that row too — the shape
    // categories are read from the answering engine's own siteFacts.
    const view = legacyViewOf(row);
    const legacy = scoredVerdict(view);
    if (view !== undefined && legacy !== null) {
      for (const label of labelsOf(view)) {
        const split = ensure(label);
        split.nLegacy += 1;
        if (legacy === "match") split.matchLegacy += 1;
      }
    }
  }
  const splits = [...byLabel.values()];
  for (const split of splits) {
    split.recallLegacy = split.nLegacy === 0 ? 0 : split.matchLegacy / split.nLegacy;
    split.recallMerged = split.nMerged === 0 ? 0 : split.matchMerged / split.nMerged;
    split.nSecondEngine = split.nMerged - split.nLegacy;
  }
  // By LABEL, never by size. The two selections have to print this block
  // byte-identically on its legacy columns, and a size key reorders the rows
  // the moment the merged denominator grows (bd tea-rags-mcp-w205u).
  return splits.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The fan columns for one label (bd tea-rags-mcp-w205u, E4.0.3).
 *
 * Never summed with the 1:1 tally and never printed in its table (D3). The
 * denominators differ on purpose and are all published rather than inferred:
 * `fanScored` gates on the oracle having an in-project target (no ground truth,
 * no rate), while `fanSites` counts every fan whatever the oracle said, because
 * `precisionProxy` asks "how thin is the average fan we emit", not "how thin is
 * the average fan we got right".
 */
export interface PyFanTally {
  label: string;
  /** Rows the dispatch layer answered with a hypothesis set — `|fan| > 1`. */
  fanSites: number;
  /** Over-cap decisions: no edges, no fallback. */
  ambiguousSites: number;
  /** Rows where the fan collapsed to ONE target and replaced the chain's 1:1 answer. */
  singleSites: number;
  /** Rows that ended 1:1 — the fan-out was empty, or it pinned one target. */
  oneToOneSites: number;
  /** `fan` + `ambiguous` rows carrying an in-project oracle target. */
  fanScored: number;
  fanHits: number;
  recallAtFan: number;
  fanSizeMean: number;
  fanSizeP50: number;
  fanSizeP95: number;
  /** `ambiguous / (fan + ambiguous + 1:1)` — the cap's bite over the whole population. */
  ambiguousShare: number;
  /** `ambiguous / (fan + ambiguous)` — the spec's E4.0 B denominator, kept beside it. */
  ambiguousShareOfFanned: number;
  /** `Σ 1/|fan|` over HITTING fan rows, over `fanSites`. A 1-edge fan scores 1.0, a 10-edge fan 0.1. */
  precisionProxy: number;
  /** Fan rows whose in-project oracle target is NOT in the fan — the narrowing dropped it. */
  fanPhantom: number;
  fanPhantomRate: number;
}

/**
 * `sorted[min(floor(n * q), n - 1)]` — `contracts/signal-utils.ts`'s convention,
 * so two percentiles in one repo do not mean two different things. 0 when empty,
 * where `p95` returns 1 to protect a divisor it feeds; nothing divides by this.
 */
function percentileFloor(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(Math.floor(sorted.length * quantile), sorted.length - 1)] ?? 0;
}

function emptyFanTally(label: string): PyFanTally {
  return {
    label,
    fanSites: 0,
    ambiguousSites: 0,
    singleSites: 0,
    oneToOneSites: 0,
    fanScored: 0,
    fanHits: 0,
    recallAtFan: 0,
    fanSizeMean: 0,
    fanSizeP50: 0,
    fanSizeP95: 0,
    ambiguousShare: 0,
    ambiguousShareOfFanned: 0,
    precisionProxy: 0,
    fanPhantom: 0,
    fanPhantomRate: 0,
  };
}

/**
 * Fold the fan columns under every label a row carries — the same key function
 * `tallyPyRows` takes, so there is no second grouping concept.
 *
 * `ambiguous` counts as a recall MISS and is excluded from `fanSize*` and
 * `precisionProxy` (D4): an over-cap decision threw the right answer away and
 * that is a cost of the cap, but there is no fan to size. A row the walk scored
 * without the dispatch layer (`row.dispatch` absent) is skipped entirely — a
 * layer that never ran is not a `none` outcome measured.
 */
export function tallyPyFan(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): PyFanTally[] {
  const byLabel = new Map<string, PyFanTally>();
  const sizes = new Map<string, number[]>();
  const proxySum = new Map<string, number>();
  for (const row of rows) {
    const fan = row.dispatch;
    if (fan === undefined) continue;
    for (const label of labelsOf(row)) {
      let tally = byLabel.get(label);
      if (tally === undefined) {
        tally = emptyFanTally(label);
        byLabel.set(label, tally);
      }
      if (fan.kind === "ambiguous") tally.ambiguousSites += 1;
      else if (fan.kind === "fan") {
        tally.fanSites += 1;
        const bucket = sizes.get(label) ?? [];
        bucket.push(fan.fanSize);
        sizes.set(label, bucket);
      } else {
        tally.oneToOneSites += 1;
        if (fan.kind === "single") tally.singleSites += 1;
        continue;
      }
      if (!fan.oracleInProject) continue;
      tally.fanScored += 1;
      if (fan.hitsOracle) {
        tally.fanHits += 1;
        proxySum.set(label, (proxySum.get(label) ?? 0) + 1 / fan.fanSize);
      } else if (fan.kind === "fan") tally.fanPhantom += 1;
    }
  }
  const tallies = [...byLabel.values()];
  for (const tally of tallies) {
    const sorted = [...(sizes.get(tally.label) ?? [])].sort((a, b) => a - b);
    const fanned = tally.fanSites + tally.ambiguousSites;
    const total = fanned + tally.oneToOneSites;
    // Only a `fan` row can hit or phantom — an `ambiguous` row carries no fan
    // to test — so the two sum to the fan rows that had ground truth.
    const scoredFans = tally.fanHits + tally.fanPhantom;
    tally.recallAtFan = tally.fanScored === 0 ? 0 : tally.fanHits / tally.fanScored;
    tally.fanSizeMean = sorted.length === 0 ? 0 : sorted.reduce((sum, size) => sum + size, 0) / sorted.length;
    tally.fanSizeP50 = percentileFloor(sorted, 0.5);
    tally.fanSizeP95 = percentileFloor(sorted, 0.95);
    tally.ambiguousShare = total === 0 ? 0 : tally.ambiguousSites / total;
    tally.ambiguousShareOfFanned = fanned === 0 ? 0 : tally.ambiguousSites / fanned;
    tally.precisionProxy = tally.fanSites === 0 ? 0 : (proxySum.get(tally.label) ?? 0) / tally.fanSites;
    tally.fanPhantomRate = scoredFans === 0 ? 0 : tally.fanPhantom / scoredFans;
  }
  return tallies.sort((a, b) => a.label.localeCompare(b.label));
}

/** One side of a fan transition, as a dumped row spells it. */
export interface DumpedFanRow {
  dispatchOutcome?: string;
  fanSize?: number;
}

export interface FanTransitionSummary {
  /** `${before} -> ${after}` → count, biggest group first, ties by key. */
  transitions: [string, number][];
  /** `afterSize - beforeSize` → count, over pairs where BOTH sides fanned. */
  sizeDeltas: [number, number][];
}

/**
 * Fan transitions between two row dumps (bd tea-rags-mcp-w205u, Step 8).
 *
 * It lives here rather than in the scratch differ because a differ that has to
 * be re-derived per A/B is a differ nobody trusts: an E4.1 run wants to say
 * "these 40 sites went `none` → `fan`" without a bespoke script, and the rule
 * for what counts as a transition should be pinned by a test. The scratch
 * driver keeps the file IO and the reporting; this owns the grouping.
 *
 * A missing `dispatchOutcome` reads `none` — that is what a `--no-dispatch`
 * dump means, and it is the common BEFORE side of the interesting comparison.
 */
export function summarizeFanTransitions(
  pairs: readonly { before: DumpedFanRow; after: DumpedFanRow }[],
): FanTransitionSummary {
  const transitions = new Map<string, number>();
  const deltas = new Map<number, number>();
  for (const { before, after } of pairs) {
    const from = before.dispatchOutcome ?? "none";
    const to = after.dispatchOutcome ?? "none";
    const key = `${from} -> ${to}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    if (from !== "fan" || to !== "fan") continue;
    const delta = (after.fanSize ?? 0) - (before.fanSize ?? 0);
    deltas.set(delta, (deltas.get(delta) ?? 0) + 1);
  }
  return {
    transitions: [...transitions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    sizeDeltas: [...deltas.entries()].sort((a, b) => a[0] - b[0]),
  };
}

/** The three gap counters E4.0.3 exists to publish (bd tea-rags-mcp-w205u, Step 9). */
export interface PyDispatchGap {
  /** Sites where the exact chain would have scored `match` and a fan replaced it. */
  exactReplacedByFan: number;
  /** Same, replaced by an over-cap `ambiguous` decision — no edge at all. */
  exactReplacedByAmbiguous: number;
  /** Sites the exact chain declined where the fan contains the oracle's target. */
  fanRescued: number;
  /**
   * Sites where the cone collapsed to ONE target and that target lost a match
   * the chain had. Not in the plan's three, but it is the same loss through the
   * other door — a `single` outcome replaces the chain's answer just as a fan
   * does, it simply stays inside the 1:1 columns while doing it.
   */
  exactReplacedBySingle: number;
  /** The mirror: a `single` cone answer that scored `match` where the chain did not. */
  singleRescued: number;
  /** Every site the dispatch layer answered with something — the parity gap's size. */
  dispatchAnswered: number;
}

/**
 * How much production's fan-first order costs, and what it buys.
 *
 * `exactReplaced*` is the loss: a confidence-1 edge the chain had, traded for a
 * hypothesis set or for nothing. `fanRescued` is the gain, and the two are NOT
 * netted — they are different products (D3), so the report prints both.
 * `skippedInProject` counts as a declined chain exactly as `tallyPyRows` folds
 * it into `missed`.
 */
export function tallyPyDispatchGap(rows: readonly PyOracleRow[]): PyDispatchGap {
  const gap: PyDispatchGap = {
    exactReplacedByFan: 0,
    exactReplacedByAmbiguous: 0,
    fanRescued: 0,
    exactReplacedBySingle: 0,
    singleRescued: 0,
    dispatchAnswered: 0,
  };
  for (const row of rows) {
    const fan = row.dispatch;
    if (fan === undefined || fan.kind === "none") continue;
    gap.dispatchAnswered += 1;
    if (fan.kind === "single") {
      if (row.exactVerdict === "match" && row.verdict !== "match") gap.exactReplacedBySingle += 1;
      if (row.exactVerdict !== "match" && row.verdict === "match") gap.singleRescued += 1;
      continue;
    }
    if (row.exactVerdict === "match") {
      if (fan.kind === "fan") gap.exactReplacedByFan += 1;
      else gap.exactReplacedByAmbiguous += 1;
    }
    const declined = row.exactVerdict === "missed" || row.exactVerdict === "skippedInProject";
    if (fan.kind === "fan" && declined && fan.hitsOracle) gap.fanRescued += 1;
  }
  return gap;
}
