/**
 * The THIRD VOTE (bd tea-rags-mcp-1v12o.1.4, E5.0d).
 *
 * jedi and the chain disagree on a few hundred rows across the five corpora,
 * and the E4 increments have been carrying every one of them as debt: D9's
 * `OW:Mro`, `OW:EnumClassmethod`, `OW:ShadowedPackage`, `OW:Self`, `OW:Mapped`,
 * E4.4a's `oracleEnumClsMember` and the 32 `cls(...)` rows were all classified
 * by HAND, one audit at a time, and each audit's verdict lived in a spec
 * paragraph rather than in the harness. This module is that reading made
 * mechanical: pyright is asked about every disagreement site and a fixed rule
 * re-scores the row.
 *
 * It is a THIRD DENOMINATOR, never a replacement. `recallLegacy` and
 * `recallMerged` are computed from `verdict`, and the stage writes only
 * `verdictTiebroken` — which is what lets `--no-tiebreak` reproduce every
 * published column byte for byte. The merge itself is untouched: pyright still
 * never repairs a file jedi read cleanly (`mergeOracleReplies`), because a
 * per-SITE engine mix would put two module resolutions behind one `jedi.Script`
 * cache. The third vote is scored BESIDE the merge, not inside it.
 *
 * Withholding is the honest outcome and a common one. A row the third vote
 * cannot decide leaves the denominator rather than being scored either way:
 * `undecidable` when pyright names a third symbol or cannot answer,
 * `oracleWrongExternal` when pyright backs the chain's silence on a `missed`
 * row (there is no edge there to call a match), `oracleSelfReference` when the
 * oracle resolved the caller's own symbol. All three are counted and printed.
 */
import {
  isWithheldFromRates,
  legacyViewOf,
  type PyOracleFileReply,
  type PyOracleRow,
  type PyOracleVerdict,
  type PyTiebreakClass,
  type PyTiebrokenVerdict,
} from "./py-oracle-core.js";

/**
 * The four verdicts where the two engines ACTUALLY disagree about the chain.
 *
 * `match` and `agreeExternal` are agreement; `bothUnresolved` and `chainOnly`
 * carry no oracle claim to arbitrate. Asking pyright about them would spend the
 * wall to confirm what two engines already said.
 */
export const PY_DISAGREEMENT_VERDICTS: ReadonlySet<PyOracleVerdict> = new Set([
  "phantom",
  "wrongFile",
  "missed",
  "fileOnly",
]);

/** The tiebroken recall denominator — `RECALL_VERDICTS`, read off `verdictTiebroken`. */
const RECALL_TIEBROKEN: ReadonlySet<PyTiebrokenVerdict> = new Set(["match", "fileOnly", "wrongFile", "missed"]);

/** The three tiebroken-only verdicts: withheld from the rates, and all counted. */
const WITHHELD_TIEBROKEN: ReadonlySet<PyTiebrokenVerdict> = new Set([
  "undecidable",
  "oracleSelfReference",
  "oracleWrongExternal",
]);

/** pyright's answer about ONE site, flattened to what the rule reads. */
export interface PyrightReply {
  kind: "inProject" | "external" | "unknown" | "parseFailed" | "missing";
  targetRelPath: string | null;
  targetSymbolId: string | null;
}

/** A site pyright was asked about and did not answer — `noAnswer`, never silence read as external. */
export const PYRIGHT_NO_ANSWER: PyrightReply = { kind: "missing", targetRelPath: null, targetSymbolId: null };

/**
 * Is this row in the disagreement set the stage asks pyright about?
 *
 * A row already withheld from the rates is excluded: a degraded parse, a
 * non-callable target or a fan-replaced site carries no 1:1 verdict to
 * arbitrate, so re-scoring it would change nothing while costing pyright the
 * whole of polar's damaged file set.
 */
export function isDisagreementRow(row: PyOracleRow): boolean {
  return !isWithheldFromRates(row) && PY_DISAGREEMENT_VERDICTS.has(row.verdict);
}

/**
 * The parameter-declaration shape: `cls(session)` inside `from_session`.
 *
 * `cls` is a parameter whose definition line IS the enclosing `def` line, so
 * both engines answer the enclosing classmethod — the caller's own symbol. The
 * correct edge is the class's `__init__`, nothing published emits one, and no
 * chain answer can score against a target that names the caller. 32 rows on the
 * five corpora (E4.4 decision 3), withheld rather than counted as misses.
 *
 * Read off BOTH engines' answers: on polar jedi produced 18 of them and pyright
 * 7, so consulting one alone would leave the other half in the denominator.
 *
 * Callers scope this to the DISAGREEMENT SET — see `applyTiebreak`. A recursive
 * call answers the caller's own symbol too, and there nobody is wrong.
 */
export function isOracleSelfReference(
  row: Pick<PyOracleRow, "oracleTargetSymbolId">,
  callerSymbolId: string | undefined,
  pyright?: PyrightReply,
): boolean {
  if (callerSymbolId === undefined) return false;
  if (row.oracleTargetSymbolId === callerSymbolId) return true;
  return pyright?.kind === "inProject" && pyright.targetSymbolId === callerSymbolId;
}

/**
 * Which engine pyright backed, at FILE+SYMBOL granularity.
 *
 * An `external` answer is read against what the two engines claimed rather than
 * folded into one arm: where the chain stayed silent it backs the chain (the
 * decline was right), where jedi ALSO said external it backs jedi (the `phantom`
 * shape — the chain invented an edge both other engines refuse), and where both
 * named an in-project target it backs neither and the row is undecidable.
 */
export function classifyTiebreak(row: PyOracleRow, pyright: PyrightReply): PyTiebreakClass {
  if (pyright.kind !== "inProject" && pyright.kind !== "external") return "noAnswer";
  if (pyright.kind === "external") {
    if (row.chainOutput === "none") return "agreesWithChain";
    return row.oracleTargetRelPath === null ? "agreesWithJedi" : "third";
  }
  const { chain } = row;
  if (pyright.targetRelPath === chain?.targetRelPath && pyright.targetSymbolId === chain.targetSymbolId) {
    return "agreesWithChain";
  }
  if (pyright.targetRelPath === row.oracleTargetRelPath && pyright.targetSymbolId === row.oracleTargetSymbolId) {
    return "agreesWithJedi";
  }
  return "third";
}

/**
 * The rule table, whole. One verdict × one tiebreak class → one verdict.
 *
 * `agreesWithChain` on a `missed` row does NOT become a match: the chain
 * emitted no edge there, and manufacturing one would let the oracle's error buy
 * recall the resolver never earned. The row leaves the denominator instead.
 */
export function rescoreVerdict(verdict: PyOracleVerdict, tiebreak: PyTiebreakClass): PyTiebrokenVerdict {
  if (tiebreak === "selfReference") return "oracleSelfReference";
  if (tiebreak === "notAsked" || tiebreak === "agreesWithJedi") return verdict;
  if (tiebreak === "third" || tiebreak === "noAnswer") return "undecidable";
  return verdict === "missed" ? "oracleWrongExternal" : "match";
}

/** The four fields the stage writes on a row. Absent entirely when the stage did not run. */
export interface PyRowTiebreak {
  tiebreak: PyTiebreakClass;
  verdictTiebroken: PyTiebrokenVerdict;
  pyrightTargetRelPath: string | null;
  pyrightTargetSymbolId: string | null;
}

/**
 * One row's whole third-vote outcome. Pure: the pyright reply is a parameter.
 *
 * `pyright` is `undefined` for every row outside the disagreement set — those
 * keep their verdict under the tiebroken denominator too, so the three columns
 * stay comparable row for row.
 */
export function tiebreakRow(
  row: PyOracleRow,
  callerSymbolId: string | undefined,
  pyright: PyrightReply | undefined,
): PyRowTiebreak {
  const selfReference = isOracleSelfReference(row, callerSymbolId, pyright);
  const tiebreak: PyTiebreakClass = selfReference
    ? "selfReference"
    : pyright === undefined
      ? "notAsked"
      : classifyTiebreak(row, pyright);
  return {
    tiebreak,
    verdictTiebroken: rescoreVerdict(row.verdict, tiebreak),
    pyrightTargetRelPath: pyright?.kind === "inProject" ? pyright.targetRelPath : null,
    pyrightTargetSymbolId: pyright?.kind === "inProject" ? pyright.targetSymbolId : null,
  };
}

/** What the stage did, per corpus. Printed whole: a re-score nobody can count is not a measurement. */
export interface PyTiebreakCounts {
  /** Rows in the disagreement set — the population the rule may move. */
  disagreementSites: number;
  /** Files carrying at least one of them, and every site pyright was asked about. */
  filesAsked: number;
  sitesAsked: number;
  agreesWithChain: number;
  agreesWithJedi: number;
  third: number;
  noAnswer: number;
  /** Self-reference rows, total and split by the verdict they carried. */
  selfReference: number;
  selfReferenceByVerdict: Record<string, number>;
  /** Wall the stage added, milliseconds — gate (e). */
  wallMs: number;
}

/** A zeroed counter block, so a corpus with no disagreement still prints the row. */
export function emptyTiebreakCounts(): PyTiebreakCounts {
  return {
    disagreementSites: 0,
    filesAsked: 0,
    sitesAsked: 0,
    agreesWithChain: 0,
    agreesWithJedi: 0,
    third: 0,
    noAnswer: 0,
    selfReference: 0,
    selfReferenceByVerdict: {},
    wallMs: 0,
  };
}

/** Fold one row's outcome into the counters. */
export function countTiebreak(counts: PyTiebreakCounts, row: PyOracleRow, outcome: PyRowTiebreak): void {
  if (outcome.tiebreak === "selfReference") {
    counts.selfReference += 1;
    counts.selfReferenceByVerdict[row.verdict] = (counts.selfReferenceByVerdict[row.verdict] ?? 0) + 1;
    return;
  }
  if (outcome.tiebreak === "notAsked") return;
  counts[outcome.tiebreak] += 1;
}

/**
 * A call site as the stage reads it — `relPath` and `startLine` to select the
 * ask cohort, the caller's own symbol for the self-reference rule. Structural
 * on purpose: `PyChainSite` lives in the host, and importing it here would
 * close a cycle for three fields.
 */
export interface TiebreakSite {
  relPath: string;
  startLine: number;
  callerSymbolId?: string;
}

/** Which sites go to pyright, and where each one's answer lands in its file's reply. */
export interface TiebreakAskPlan {
  /** Row indices pyright arbitrates, ascending. */
  arbitrated: number[];
  /** Every site index sent — the arbitrated sites plus their LINE cohort. */
  sent: number[];
  /** Site index → the position of its answer inside its file's reply. */
  answerIndex: Map<number, number>;
  /** The files asked about, sorted as `askOracle` writes them. */
  files: string[];
}

/**
 * Plan the ask: the arbitrated sites plus every site sharing their LINE.
 *
 * `askOracle` claims successive occurrences of a callee as it walks a file's
 * batch, and that claim is keyed by `startLine` — so sending a bare subset would
 * re-pin the second `f` of `f(x), f(y)` to the leftmost one and ask pyright
 * about the wrong callee, while a site on any OTHER line cannot reach it at
 * all. Keeping the whole line cohort is therefore byte-exact on the columns and
 * still asks about a few hundred sites rather than a few thousand: whole files
 * (what the E4.0.4 audit driver sent) costs polar ~20× the wall for the same
 * answers.
 */
export function planTiebreakAsk(
  rows: readonly PyOracleRow[],
  sites: readonly TiebreakSite[],
  shouldAsk: (row: PyOracleRow, index: number) => boolean,
): TiebreakAskPlan {
  const arbitrated: number[] = [];
  const lines = new Set<string>();
  const files = new Set<string>();
  const lineKey = (site: TiebreakSite): string => `${site.relPath}:${String(site.startLine)}`;
  for (const [index, row] of rows.entries()) {
    const site = sites[index];
    if (site === undefined || !shouldAsk(row, index)) continue;
    arbitrated.push(index);
    lines.add(lineKey(site));
    files.add(site.relPath);
  }
  const sent: number[] = [];
  const answerIndex = new Map<number, number>();
  const cursor = new Map<string, number>();
  for (const [index, site] of sites.entries()) {
    if (!lines.has(lineKey(site))) continue;
    const position = cursor.get(site.relPath) ?? 0;
    cursor.set(site.relPath, position + 1);
    sent.push(index);
    answerIndex.set(index, position);
  }
  return { arbitrated, sent, answerIndex, files: [...files].sort() };
}

/** pyright's reply for one site, read off the file reply at the planned position. */
export function pyrightReplyAt(reply: PyOracleFileReply | undefined, index: number | undefined): PyrightReply {
  const answer = index === undefined ? undefined : reply?.answers[index];
  if (answer === undefined) return PYRIGHT_NO_ANSWER;
  const target = answer.outcome.targets?.[0];
  return {
    kind: answer.outcome.kind,
    targetRelPath: answer.outcome.kind === "inProject" ? (target?.relPath ?? null) : null,
    // A `pinUncertain` target names no symbol, and inventing one here would let
    // a file-granularity answer arbitrate a symbol-granularity disagreement.
    targetSymbolId:
      answer.outcome.kind === "inProject" && target?.pinUncertain !== true ? (target?.symbolId ?? null) : null,
  };
}

/**
 * Score every row against the third vote. Pure given the replies.
 *
 * Rows outside the plan keep their verdict under the tiebroken denominator —
 * `notAsked` — so the three columns stay comparable row for row.
 *
 * The self-reference pre-empt runs on the DISAGREEMENT SET only, arbitrated or
 * not. Scoping it there is not a simplification: `foo()` inside `foo` also
 * resolves to the caller's own symbol, and there both engines and the chain are
 * RIGHT. Applied corpus-wide the rule withheld 4 correct ugnest `match` rows
 * before the scope was added. The shape is debt only where the two engines
 * disagree — that is where `cls` being a parameter shows up as a miss.
 */
export function applyTiebreak(
  rows: readonly PyOracleRow[],
  sites: readonly TiebreakSite[],
  plan: TiebreakAskPlan,
  replies: ReadonlyMap<string, PyOracleFileReply>,
): { rows: PyOracleRow[]; counts: PyTiebreakCounts } {
  const arbitrated = new Set(plan.arbitrated);
  const counts = emptyTiebreakCounts();
  counts.disagreementSites = plan.arbitrated.length;
  counts.filesAsked = plan.files.length;
  counts.sitesAsked = plan.sent.length;
  const scored = rows.map((row, index) => {
    const pyright = arbitrated.has(index)
      ? pyrightReplyAt(replies.get(row.relPath), plan.answerIndex.get(index))
      : undefined;
    // An undefined caller symbol makes the pre-empt inert, which is how a row
    // outside the disagreement set keeps a legitimate recursive answer.
    const callerSymbolId = isDisagreementRow(row) ? sites[index]?.callerSymbolId : undefined;
    const outcome = tiebreakRow(row, callerSymbolId, pyright);
    countTiebreak(counts, row, outcome);
    return { ...row, ...outcome };
  });
  return { rows: scored, counts };
}

/** One label's recall under the TIEBROKEN denominator, beside the other two. */
export interface PyTiebrokenSplit {
  label: string;
  recallTiebroken: number;
  nTiebroken: number;
  matchTiebroken: number;
  /** Rows the stage took OUT of the denominator — undecidable, self-reference, oracle-wrong-external. */
  withheldTiebroken: number;
}

export function tallyPyTiebroken(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): PyTiebrokenSplit[] {
  const byLabel = new Map<string, PyTiebrokenSplit>();
  const ensure = (label: string): PyTiebrokenSplit => {
    let split = byLabel.get(label);
    if (split === undefined) {
      split = { label, recallTiebroken: 0, nTiebroken: 0, matchTiebroken: 0, withheldTiebroken: 0 };
      byLabel.set(label, split);
    }
    return split;
  };
  for (const row of rows) {
    if (isWithheldFromRates(row)) continue;
    // `skippedInProject` folds into `missed` exactly as the other two tallies
    // fold it, or the three columns would disagree about the same rows.
    const raw = row.verdictTiebroken ?? row.verdict;
    const verdict = raw === "skippedInProject" ? "missed" : raw;
    for (const label of labelsOf(row)) {
      const split = ensure(label);
      if (RECALL_TIEBROKEN.has(verdict)) {
        split.nTiebroken += 1;
        if (verdict === "match") split.matchTiebroken += 1;
      } else if (WITHHELD_TIEBROKEN.has(verdict)) {
        split.withheldTiebroken += 1;
      }
    }
  }
  const splits = [...byLabel.values()];
  for (const split of splits) {
    split.recallTiebroken = split.nTiebroken === 0 ? 0 : split.matchTiebroken / split.nTiebroken;
  }
  // By LABEL, never by size — the block has to diff clean against the legacy
  // and merged tables it is printed beside.
  return splits.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Precision miss under all three denominators: `(phantom + wrongFile) / edges`.
 *
 * `edges` counts every row the chain pinned or file-pinned, withheld ones
 * included, because that is the number the header publishes and the number D9's
 * audit divided by. Only the NUMERATOR moves under the tiebroken column: a row
 * the third vote cannot judge still emitted its edge.
 */
export interface PyPrecisionSplit {
  label: string;
  edgesLegacy: number;
  phantomLegacy: number;
  wrongFileLegacy: number;
  precisionMissLegacy: number;
  edgesMerged: number;
  phantomMerged: number;
  wrongFileMerged: number;
  precisionMissMerged: number;
  phantomTiebroken: number;
  wrongFileTiebroken: number;
  precisionMissTiebroken: number;
}

export function tallyPyPrecision(
  rows: readonly PyOracleRow[],
  labelsOf: (row: PyOracleRow) => readonly string[],
): PyPrecisionSplit[] {
  const byLabel = new Map<string, PyPrecisionSplit>();
  const ensure = (label: string): PyPrecisionSplit => {
    let split = byLabel.get(label);
    if (split === undefined) {
      split = {
        label,
        edgesLegacy: 0,
        phantomLegacy: 0,
        wrongFileLegacy: 0,
        precisionMissLegacy: 0,
        edgesMerged: 0,
        phantomMerged: 0,
        wrongFileMerged: 0,
        precisionMissMerged: 0,
        phantomTiebroken: 0,
        wrongFileTiebroken: 0,
        precisionMissTiebroken: 0,
      };
      byLabel.set(label, split);
    }
    return split;
  };
  for (const row of rows) {
    const scored = !isWithheldFromRates(row);
    const tiebroken = row.verdictTiebroken ?? row.verdict;
    for (const label of labelsOf(row)) {
      const split = ensure(label);
      if (row.chainOutput !== "none") split.edgesMerged += 1;
      if (!scored) continue;
      if (row.verdict === "phantom") split.phantomMerged += 1;
      if (row.verdict === "wrongFile") split.wrongFileMerged += 1;
      if (tiebroken === "phantom") split.phantomTiebroken += 1;
      if (tiebroken === "wrongFile") split.wrongFileTiebroken += 1;
    }
    // The legacy side reads its OWN row and its OWN labels, exactly as
    // `tallyPyRecall` does — the shape categories come from the answering engine.
    const view = legacyViewOf(row);
    if (view === undefined) continue;
    const legacyScored = !isWithheldFromRates(view);
    for (const label of labelsOf(view)) {
      const split = ensure(label);
      if (view.chainOutput !== "none") split.edgesLegacy += 1;
      if (!legacyScored) continue;
      if (view.verdict === "phantom") split.phantomLegacy += 1;
      if (view.verdict === "wrongFile") split.wrongFileLegacy += 1;
    }
  }
  const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);
  const splits = [...byLabel.values()];
  for (const split of splits) {
    split.precisionMissLegacy = rate(split.phantomLegacy + split.wrongFileLegacy, split.edgesLegacy);
    split.precisionMissMerged = rate(split.phantomMerged + split.wrongFileMerged, split.edgesMerged);
    split.precisionMissTiebroken = rate(split.phantomTiebroken + split.wrongFileTiebroken, split.edgesMerged);
  }
  return splits.sort((a, b) => a.label.localeCompare(b.label));
}
