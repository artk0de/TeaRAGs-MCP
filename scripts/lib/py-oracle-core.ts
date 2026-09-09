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
  facts: PySiteFacts | undefined,
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
  facts: PySiteFacts | undefined;
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
 * A row carrying no ground truth: counted in `sites`, withheld from every rate.
 *
 * Three populations, one predicate, because the tally treats them identically —
 * a degraded parse, a file with no AST at all, and an in-project answer whose
 * target is not a definition. What they share is that no verdict about the
 * CHAIN can be read off them.
 */
function isWithheldFromRates(row: PyOracleRow): boolean {
  return row.oracleDegraded || row.verdict === "parseFailed" || row.verdict === "oracleNonCallable";
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
      // `skippedInProject` is a MISS the classifier caused; it belongs in the
      // recall numerator so a vocabulary that over-claims cannot buy a better
      // rate by moving sites out of `missed`.
      verdict: row.verdict === "skippedInProject" ? "missed" : row.verdict,
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
