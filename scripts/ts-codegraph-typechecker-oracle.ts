/**
 * TypeScript codegraph oracle — diff the tree-sitter resolver chain against the
 * real type checker, call site by call site (bd tea-rags-mcp-yttre).
 *
 * Ruby's recall harness (`scripts/taxdome-codegraph-recall-forensics.ts`) has to
 * hand-author an oracle function per hypothesis, because Ruby has no type
 * checker and "correct" can only be asserted by a human. TypeScript does not
 * have that problem: `ts.TypeChecker` IS ground truth. So this harness is a
 * different mechanism rather than a port — for every call site it computes BOTH
 * answers and diffs them:
 *
 *   - the CHAIN answer: `TSCallResolver#resolve`, the whole ordered strategy
 *     chain as a black box (ten tree-sitter passes plus whatever type-checker
 *     strategies have landed by the time this runs);
 *   - the ORACLE answer: an independent `getResolvedSignature` /
 *     `getSymbolAtLocation` query against the same `ts.Program`.
 *
 * A disagreement is one of two things, and the bucket says which:
 *
 *   - `missed` — the checker resolved a call the chain declined. This is the
 *     recall gap, and grouped by category it is the whole point of the harness:
 *     it ranks which type-system feature actually costs edges on real code,
 *     instead of guessing from a taxonomy table.
 *   - `wrongFile` — both answered and disagreed. A heuristic fired and was
 *     wrong; precision bug, strictly worse than declining.
 *
 * `chainOnly` is deliberately NOT a mismatch. The checker declines on externals
 * (`node_modules`, the default lib) and on anything outside the Program's
 * bounded import closure, so counting those against the chain would measure the
 * oracle's blind spot rather than the resolver's.
 *
 * MEASUREMENT CUTOVER — `phantom` changed meaning on 2026-08-10, in the commit
 * carrying bd tea-rags-mcp-ffju3 (`git log --grep=ffju3 -- scripts/`). RAW
 * PHANTOM COUNTS FROM BEFORE THAT COMMIT ARE NOT COMPARABLE WITH COUNTS FROM
 * AFTER IT. The external branch of
 * `diffResolution` used to call ANY non-null chain answer a phantom, and the
 * chain routinely answers with a `node_modules` declaration — the very
 * conclusion the checker reached. On this repo's `src/` that misfiled 3510 of
 * 3614 raw phantoms as fabricated edges. The branch now compares conclusions,
 * and the same corpus reads 104 raw. Nothing about the resolver changed: the
 * decomposed defect residual is 93 both before and after. So a historical
 * headline of 1341 (Track C), 1344 (`pmxuv`) or 3612 (`cko34`) is measuring
 * something this script no longer measures — do not read a drop against one as
 * a precision win, and do not read a rise as a regression.
 *
 * WHAT THIS SHARES WITH PRODUCTION, AND WHY
 *
 * The `ts.Program`s come from the resolver's OWN `TSProgramCache`
 * (`TSCallResolver.programCache`, exposed for exactly this), not a second cache
 * built alongside it. That matters for more than cost: the cache builds one
 * Program per entry file from a depth-bounded import closure, so a second cache
 * with different bounds would produce disagreements that are Program-scope
 * artifacts rather than resolver defects. Symbol pinning reuses the strategy's
 * own `composeSymbolId`, and node lookup its own `findCallExpression`, for the
 * same reason — the Ruby harness's header records a real measurement bug caused
 * by a hand-copied helper drifting from the original.
 *
 * The flip side is a bound worth stating: a declaration outside that closure is
 * invisible to BOTH sides, so this measures the resolver, not the ceiling of
 * what a whole-repo Program could know.
 *
 * WHAT IT DOES NOT DO
 *
 * Only the single-target contract (`resolve`) is diffed. `resolveDispatch` is a
 * fan-out contract returning N edges, which `getResolvedSignature`'s single
 * declaration cannot be compared against; call sites carrying a dispatch table
 * are counted and skipped rather than scored.
 *
 * Usage:
 *   npx tsx scripts/ts-codegraph-typechecker-oracle.ts [options]
 *
 *   --target <dir>     directory to walk, relative to repo root (default: src)
 *   --repo-root <dir>  project root holding tsconfig.json (default: cwd)
 *   --limit <n>        stop after N files (smoke runs)
 *   --json <path>      also write the full tally as JSON
 *   --samples <n>      mismatch rows per verdict in the JSON (default: 25)
 *   --quiet            suppress per-file progress
 */

import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve as resolvePath, sep } from "node:path";

import Parser from "tree-sitter";
import ts from "typescript";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  RelPath,
  SymbolDefinition,
} from "../src/core/contracts/types/codegraph.js";
import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import { loadTsConfig, TSCallResolver } from "../src/core/domains/language/typescript/index.js";
import {
  composeSymbolId,
  findCallExpression,
} from "../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import type {
  TSProgramCache,
  TSProgramHandle,
} from "../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { classifyReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { lastSegment } from "../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { materializeTree } from "../src/core/infra/materialize.js";

// ---------------------------------------------------------------------------
// Pure core — the diff, the tally, the ranking. Unit-tested in
// tests/scripts/ts-codegraph-typechecker-oracle.test.ts.
// ---------------------------------------------------------------------------

/** One side's answer: the file a call site targets, and the symbol when pinned. */
export interface OracleAnswer {
  targetRelPath: string;
  targetSymbolId: string | null;
}

/**
 * What the checker concluded about a call site. Three outcomes, because
 * "resolved to something outside the project" is a real answer and not the same
 * as "no answer": it says there IS no in-project edge here, which is exactly
 * what makes an IN-PROJECT chain answer on the same call a fabricated one.
 */
export type OracleOutcome = { kind: "inProject"; answer: OracleAnswer } | { kind: "external" } | { kind: "unknown" };

/**
 * How the two answers relate.
 *
 * Against IN-PROJECT ground truth: `match` / `fileOnly` are agreement at symbol
 * / file granularity; `wrongFile` and `missed` are the mismatch kinds.
 *
 * Against EXTERNAL ground truth: `agreeExternal` is the two sides reaching the
 * same conclusion — the chain either declined outright or named an external
 * declaration itself. `phantom` is the chain inventing an IN-PROJECT target for
 * a call that provably leaves the project: a precision defect strictly worse
 * than declining, and invisible unless external is tracked separately.
 *
 * `chainOnly` and `bothUnresolved` carry no ground truth at all and sit outside
 * every rate.
 */
export type OracleVerdict =
  | "match"
  | "fileOnly"
  | "wrongFile"
  | "missed"
  | "phantom"
  | "agreeExternal"
  | "chainOnly"
  | "bothUnresolved";

/** Type-system features a call site exercises. A site can carry several. */
export const TYPE_FEATURE_CATEGORIES = [
  "generic",
  "overload",
  "unionNarrowing",
  "structuralTyping",
  "returnTypeInference",
  "jsx",
  "plain",
] as const;

export type TypeFeatureCategory = (typeof TYPE_FEATURE_CATEGORIES)[number];

/**
 * Where the checker's chosen declaration lives. `defaultLib` and
 * `externalPackage` are both outside the project but mean different things to
 * precision analysis: a default-lib member (`Array#push`) is something the
 * project can never own, while an external package's interface may well be
 * implemented in-project. `generatedInRepo` is the artifact class — the
 * project's OWN compiled output, where an in-project chain answer may be right.
 */
export type OracleTargetOrigin = "project" | "defaultLib" | "externalPackage" | "generatedInRepo" | "outsideRepo";

/**
 * What the checker's declaration IS, as opposed to merely where it points.
 * Decomposition reads these facts to tell a genuine resolver defect from the
 * two things that look like one: a declaration site answered with its
 * implementation, and a callable with no name to resolve to in the first place.
 */
export interface OracleTargetFacts {
  /** Repo-relative path of the declaration; `null` when it sits outside the repo. */
  relPath: string | null;
  /** Project symbolId the declaration pinned to, `null` when the graph has no node for it. */
  symbolId: string | null;
  shortName: string | null;
  /** `ts.SyntaxKind` name, carried so a surprising bucket can be read back to source. */
  declarationKind: string;
  /** A declaration site with no body: interface member, abstract method, overload signature, ambient. */
  declarationOnly: boolean;
  /** A callable with no nameable declaration site: arrow function, function expression, parameter. */
  anonymousCallable: boolean;
  origin: OracleTargetOrigin;
}

/** One scored call site. */
export interface OracleRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiverKind: string;
  categories: string[];
  verdict: OracleVerdict;
  /** What the chain answered, carried so mismatch samples are actionable. */
  chain?: OracleAnswer;
  /** What the checker's declaration is. Absent when the checker located none. */
  target?: OracleTargetFacts;
}

/** Verdict counts for one label, plus the two rates the ranking reads. */
export interface OracleTally {
  label: string;
  sites: number;
  /** Call sites where the checker produced an in-project answer to diff against. */
  oracle: number;
  match: number;
  fileOnly: number;
  wrongFile: number;
  missed: number;
  /** Call sites the checker proved target something outside the project. */
  external: number;
  phantom: number;
  agreeExternal: number;
  chainOnly: number;
  bothUnresolved: number;
  /** RECALL view: `(wrongFile + missed) / oracle`, 0 when there is no ground truth. */
  mismatchRate: number;
  /** PRECISION view: `phantom / external`, 0 when nothing external was proven. */
  phantomRate: number;
}

/**
 * A repo-relative path that is not project source — package typings, generated
 * output, or any declaration file. A chain answer landing here is the chain
 * saying "this call leaves the project", which is a conclusion and not an edge.
 */
function isOutsideProjectSource(relPath: string): boolean {
  return relPath.startsWith("node_modules/") || isNonSourceTarget(relPath);
}

/**
 * Classify one call site by comparing the two answers.
 *
 * Symbol-level disagreement degrades to `fileOnly` rather than `wrongFile`: the
 * emitted edge still lands on the right file, and the contract explicitly
 * allows a null `targetSymbolId` for "the file is certain, the member is not".
 * Counting that as a mismatch would drown the real precision bugs.
 *
 * Against external ground truth the comparison is between CONCLUSIONS, not
 * paths. The checker's answer there is "no in-project edge exists here", and
 * the chain says the same thing two ways: by declining, or by naming an
 * external declaration of its own. Only an in-project chain answer contradicts
 * the checker, and only that is a phantom (bd tea-rags-mcp-ffju3).
 */
export function diffResolution(chain: OracleAnswer | null, oracle: OracleOutcome): OracleVerdict {
  if (oracle.kind === "unknown") return chain === null ? "bothUnresolved" : "chainOnly";
  if (oracle.kind === "external") {
    if (chain === null) return "agreeExternal";
    return isOutsideProjectSource(chain.targetRelPath) ? "agreeExternal" : "phantom";
  }
  if (chain === null) return "missed";
  if (chain.targetRelPath !== oracle.answer.targetRelPath) return "wrongFile";
  return chain.targetSymbolId === oracle.answer.targetSymbolId ? "match" : "fileOnly";
}

/**
 * Aggregate rows under every label a row carries, ordered by call-site count
 * descending so the widest category reads first. A row with several labels is
 * counted once under each — the type-feature axis overlaps by construction
 * (a generic call can also narrow a union), and forcing a precedence order
 * would attribute sites to whichever feature happened to be checked first.
 */
export function tallyBy(rows: readonly OracleRow[], labelsOf: (row: OracleRow) => readonly string[]): OracleTally[] {
  const byLabel = new Map<string, OracleTally>();

  for (const row of rows) {
    for (const label of labelsOf(row)) {
      let tally = byLabel.get(label);
      if (!tally) {
        tally = {
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
        byLabel.set(label, tally);
      }
      tally.sites++;
      tally[row.verdict]++;
    }
  }

  const tallies = [...byLabel.values()];
  for (const tally of tallies) {
    tally.oracle = tally.match + tally.fileOnly + tally.wrongFile + tally.missed;
    tally.external = tally.phantom + tally.agreeExternal;
    tally.mismatchRate = tally.oracle === 0 ? 0 : (tally.wrongFile + tally.missed) / tally.oracle;
    tally.phantomRate = tally.external === 0 ? 0 : tally.phantom / tally.external;
  }
  return tallies.sort((a, b) => b.sites - a.sites || a.label.localeCompare(b.label));
}

/** A category the data says a Track B strategy should target. */
export interface TrackBPriority {
  label: string;
  mismatchRate: number;
  oracle: number;
  missed: number;
  wrongFile: number;
}

/** Ground-truth answers a category needs before its rate is worth acting on. */
export const PRIORITY_MIN_ORACLE_DEFAULT = 20;
/** Mismatch rate above which a category is called out for Track B. */
export const PRIORITY_MIN_MISMATCH_RATE_DEFAULT = 0.2;

/**
 * Categories whose mismatch rate clears the threshold on enough evidence,
 * worst first. The evidence floor is the load-bearing half: a category with
 * three ground-truth answers can read 100% and mean nothing.
 */
export function flagTrackBPriorities(
  tallies: readonly OracleTally[],
  opts: { minOracle?: number; minMismatchRate?: number } = {},
): TrackBPriority[] {
  const minOracle = opts.minOracle ?? PRIORITY_MIN_ORACLE_DEFAULT;
  const minMismatchRate = opts.minMismatchRate ?? PRIORITY_MIN_MISMATCH_RATE_DEFAULT;

  return tallies
    .filter((t) => t.oracle >= minOracle && t.mismatchRate >= minMismatchRate)
    .map((t) => ({
      label: t.label,
      mismatchRate: t.mismatchRate,
      oracle: t.oracle,
      missed: t.missed,
      wrongFile: t.wrongFile,
    }))
    .sort((a, b) => b.mismatchRate - a.mismatchRate || a.label.localeCompare(b.label));
}

/**
 * Expected categories the corpus produced no call site for. A blind spot in the
 * measurement, not a clean result — tea-rags-mcp has no `.tsx` at all, so `jsx`
 * lands here and the JSX track gets no signal from this corpus.
 */
export function findUncoveredCategories(tallies: readonly OracleTally[], expected: readonly string[]): string[] {
  const seen = new Set(tallies.filter((t) => t.sites > 0).map((t) => t.label));
  return expected.filter((label) => !seen.has(label));
}

const TABLE_COLUMNS = [
  "sites",
  "oracle",
  "match",
  "fileOnly",
  "wrongFile",
  "missed",
  "mismatch%",
  "ext",
  "phantom",
  "phantom%",
] as const;

/** Fixed-width console table, one row per label. */
export function formatOracleTable(title: string, tallies: readonly OracleTally[]): string {
  const labelWidth = Math.max(12, ...tallies.map((t) => t.label.length));
  const header = ["category".padEnd(labelWidth), ...TABLE_COLUMNS.map((c) => c.padStart(9))].join(" ");
  const lines = [title, "-".repeat(header.length), header, "-".repeat(header.length)];

  if (tallies.length === 0) {
    lines.push("(no call sites)");
    return lines.join("\n");
  }

  for (const tally of tallies) {
    lines.push(
      [
        tally.label.padEnd(labelWidth),
        String(tally.sites).padStart(9),
        String(tally.oracle).padStart(9),
        String(tally.match).padStart(9),
        String(tally.fileOnly).padStart(9),
        String(tally.wrongFile).padStart(9),
        String(tally.missed).padStart(9),
        `${(tally.mismatchRate * 100).toFixed(1)}%`.padStart(9),
        String(tally.external).padStart(9),
        String(tally.phantom).padStart(9),
        `${(tally.phantomRate * 100).toFixed(1)}%`.padStart(9),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mismatch decomposition — separating defects from disagreements that are not.
//
// A raw mismatch count is an upper bound on the resolver's defects, not the
// defect count. Two classes inflate it, and both are mechanical to recognise:
//
//   - a `wrongFile` where the checker named a DECLARATION SITE (an interface
//     member, an abstract method) and the chain named the implementation of
//     that same member. The two sides agree about which call this is; they
//     disagree about which end of the declaration/implementation pair to name,
//     and the graph deliberately prefers the implementation.
//   - a `missed` whose target has no name to resolve TO — a returned closure,
//     a local arrow function, a callback parameter. No strategy can emit an
//     edge to a node the graph does not contain, so declining is correct.
//
// Track C computed both by hand on the first oracle run and reported "4 sites"
// while the raw output said hundreds; the two numbers were never reconcilable
// afterwards because the filtering existed only in that session. These
// functions are that filtering, written down (bd tea-rags-mcp-cko34).
//
// Every reconciler is conservative in the same direction: missing facts count
// AGAINST the resolver. A bucket can therefore understate agreement but never
// manufacture it.
// ---------------------------------------------------------------------------

/** Why a `wrongFile` is, or is not, a precision defect. */
export type OracleWrongFileReason = "interfaceVsImpl" | "declarationSitePath" | "defect";

/** Why a `missed` is, or is not, a recall defect. */
export type OracleMissedReason = "anonymousCallable" | "unpinnedTarget" | "defect";

/** Why a `phantom` is, or is not, a fabricated edge. */
export type OraclePhantomReason =
  | "generatedInRepo"
  | "builtinMember"
  | "externalInterfaceMatch"
  | "externalPackageMember";

/**
 * Path fragments that mark a file as a declaration site by convention rather
 * than by syntax. This is the weaker of the two `wrongFile` rules — it reads
 * project layout, not the AST — so it is counted in its own bucket and never
 * folded into `interfaceVsImpl`.
 */
const DECLARATION_SITE_PATH_FRAGMENTS = ["/contracts/", "/types/"] as const;
const DECLARATION_SITE_BASENAMES = ["base.ts", "types.ts", "contracts.ts"] as const;

function isDeclarationSitePath(relPath: string | null): boolean {
  if (relPath === null) return false;
  const normalized = `/${relPath}`;
  return (
    DECLARATION_SITE_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
    DECLARATION_SITE_BASENAMES.some((basename) => normalized.endsWith(`/${basename}`))
  );
}

/**
 * The two sides named the same member. Required by both `wrongFile` rules: an
 * interface member answered with a DIFFERENT implementation member is a real
 * defect, and without this check every same-file-family disagreement would be
 * excused.
 */
function namesTheSameMember(chain: OracleAnswer | undefined, target: OracleTargetFacts): boolean {
  const chainSymbolId = chain?.targetSymbolId ?? null;
  if (chainSymbolId === null || target.shortName === null) return false;
  return lastSegment(chainSymbolId) === target.shortName;
}

/**
 * Reconcile one `wrongFile`. Interface-versus-implementation is agreement
 * expressed differently, not a heuristic firing wrong.
 */
export function reconcileOracleWrongFile(row: OracleRow): OracleWrongFileReason {
  const { target } = row;
  if (target === undefined || !namesTheSameMember(row.chain, target)) return "defect";
  if (target.declarationOnly) return "interfaceVsImpl";
  return isDeclarationSitePath(target.relPath) ? "declarationSitePath" : "defect";
}

/**
 * Reconcile one `missed`. A target the graph has no node for is unmodellable at
 * symbol granularity — note that a FILE-level edge would still have been
 * possible, so `unpinnedTarget` is "not a symbol-resolution gap" rather than
 * "not a gap at all".
 */
export function reconcileOracleMissed(row: OracleRow): OracleMissedReason {
  const { target } = row;
  if (target === undefined) return "defect";
  if (target.anonymousCallable) return "anonymousCallable";
  return target.symbolId === null ? "unpinnedTarget" : "defect";
}

/**
 * Reconcile one `phantom`. Origin is decided before shape: a default-lib member
 * is declared on an interface too, but `Array#push` is not something the
 * project could be implementing, so it must not reach the arguable bucket.
 *
 * Every row reaching here has a chain answer naming PROJECT SOURCE — the
 * verdict itself now excuses a chain answer that also leaves the project
 * (bd tea-rags-mcp-ffju3), so this reconciler no longer carries the
 * `externalAgreement` correction that used to dominate it.
 */
export function reconcileOraclePhantom(row: OracleRow): OraclePhantomReason {
  const { target } = row;
  if (target === undefined) return "externalPackageMember";
  if (target.origin === "generatedInRepo") return "generatedInRepo";
  if (target.origin === "defaultLib") return "builtinMember";
  if (target.origin === "externalPackage" && target.declarationOnly && namesTheSameMember(row.chain, target)) {
    return "externalInterfaceMatch";
  }
  return "externalPackageMember";
}

/** Raw mismatch counts for one label, split by reason, with the residual named. */
export interface OracleMismatchDecomposition {
  label: string;
  wrongFile: { total: number; interfaceVsImpl: number; declarationSitePath: number; defect: number };
  missed: { total: number; anonymousCallable: number; unpinnedTarget: number; defect: number };
  phantom: {
    total: number;
    generatedInRepo: number;
    builtinMember: number;
    externalInterfaceMatch: number;
    externalPackageMember: number;
    /** Fabricated edges: builtin plus concrete external. Excludes the arguable bucket. */
    defect: number;
  };
}

function emptyDecomposition(label: string): OracleMismatchDecomposition {
  return {
    label,
    wrongFile: { total: 0, interfaceVsImpl: 0, declarationSitePath: 0, defect: 0 },
    missed: { total: 0, anonymousCallable: 0, unpinnedTarget: 0, defect: 0 },
    phantom: {
      total: 0,
      generatedInRepo: 0,
      builtinMember: 0,
      externalInterfaceMatch: 0,
      externalPackageMember: 0,
      defect: 0,
    },
  };
}

/**
 * Decompose every mismatch under each label a row carries — same labelling
 * contract as `tallyBy`, so a feature table and its decomposition are read on
 * the same denominator. Agreement verdicts contribute to nothing.
 */
export function decomposeOracleMismatches(
  rows: readonly OracleRow[],
  labelsOf: (row: OracleRow) => readonly string[],
): OracleMismatchDecomposition[] {
  const byLabel = new Map<string, OracleMismatchDecomposition>();

  for (const row of rows) {
    if (row.verdict !== "wrongFile" && row.verdict !== "missed" && row.verdict !== "phantom") continue;

    for (const label of labelsOf(row)) {
      let decomposition = byLabel.get(label);
      if (!decomposition) {
        decomposition = emptyDecomposition(label);
        byLabel.set(label, decomposition);
      }

      if (row.verdict === "wrongFile") {
        decomposition.wrongFile.total++;
        decomposition.wrongFile[reconcileOracleWrongFile(row)]++;
      } else if (row.verdict === "missed") {
        decomposition.missed.total++;
        decomposition.missed[reconcileOracleMissed(row)]++;
      } else {
        decomposition.phantom.total++;
        decomposition.phantom[reconcileOraclePhantom(row)]++;
      }
    }
  }

  const decompositions = [...byLabel.values()];
  for (const decomposition of decompositions) {
    decomposition.phantom.defect = decomposition.phantom.builtinMember + decomposition.phantom.externalPackageMember;
  }
  return decompositions.sort(
    (a, b) =>
      b.wrongFile.total + b.missed.total + b.phantom.total - (a.wrongFile.total + a.missed.total + a.phantom.total) ||
      a.label.localeCompare(b.label),
  );
}

/** Fixed-width console table, one row per label, defects last so they read as the answer. */
export function formatDecompositionTable(
  title: string,
  decompositions: readonly OracleMismatchDecomposition[],
): string {
  const columns = [
    "wrongFile",
    "ifaceImpl",
    "declPath",
    "wfDefect",
    "missed",
    "anonFn",
    "unpinned",
    "msDefect",
    "phantom",
    "generated",
    "extIface",
    "phDefect",
  ];
  const labelWidth = Math.max(12, ...decompositions.map((d) => d.label.length));
  const header = ["category".padEnd(labelWidth), ...columns.map((c) => c.padStart(10))].join(" ");
  const lines = [title, "-".repeat(header.length), header, "-".repeat(header.length)];

  if (decompositions.length === 0) {
    lines.push("(no mismatches)");
    return lines.join("\n");
  }

  for (const d of decompositions) {
    lines.push(
      [
        d.label.padEnd(labelWidth),
        ...[
          d.wrongFile.total,
          d.wrongFile.interfaceVsImpl,
          d.wrongFile.declarationSitePath,
          d.wrongFile.defect,
          d.missed.total,
          d.missed.anonymousCallable,
          d.missed.unpinnedTarget,
          d.missed.defect,
          d.phantom.total,
          d.phantom.generatedInRepo,
          d.phantom.externalInterfaceMatch,
          d.phantom.defect,
        ].map((value) => String(value).padStart(10)),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Type-checker oracle — the independent ground-truth query.
// ---------------------------------------------------------------------------

/** What the checker had to say about one call site. */
interface OracleQueryResult {
  outcome: OracleOutcome;
  /** The call expression was located in the Program's AST. */
  located: boolean;
  /**
   * The declaration was inside the repo root but not source (`build/`, a
   * `.d.ts`). Tracked apart from a genuinely outside-the-repo declaration
   * because it is the one way `phantom` could be an artifact: a real in-project
   * target reached through a generated declaration file would be called
   * external, and the chain's correct answer would then look fabricated.
   */
  nonSource: boolean;
  categories: string[];
  /** What the located declaration IS, for decomposition. Absent when none was located. */
  target?: OracleTargetFacts;
}

const NO_ORACLE: OracleQueryResult = {
  outcome: { kind: "unknown" },
  located: false,
  nonSource: false,
  categories: ["plain"],
};

/**
 * Compiled and generated outputs that are inside the repo root but are not
 * source. `toRelPath` accepts them because they are under the root, and a
 * declaration resolved into `build/` would then be scored against the `src/`
 * file the chain names — a `wrongFile` that is purely an artifact of the
 * worktree having been built. They are external for measurement purposes.
 */
function isNonSourceTarget(relPath: string): boolean {
  return relPath.startsWith("build/") || relPath.startsWith("dist/") || relPath.endsWith(".d.ts");
}

/**
 * The checker's answer for one call site, plus the type features it exercised.
 *
 * `getResolvedSignature` is the primary query — it names the concrete signature
 * the compiler selected, which is what overload and generic resolution turn on.
 * When it declines (a call through a value whose type has one call signature, a
 * direct reference to an imported function), the symbol path is the fallback:
 * resolve the callee identifier, unwrap an import alias, take its declaration.
 */
function queryTypeChecker(handle: TSProgramHandle, cache: TSProgramCache, call: CallRef): OracleQueryResult {
  const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null) return NO_ORACLE;

  const { checker } = handle;
  const signature = checker.getResolvedSignature(node);
  const declaration = signature?.declaration ?? declarationViaSymbol(node, checker);
  const categories = classifyTypeFeatures(node, checker, signature, declaration);

  if (declaration === undefined) return { outcome: { kind: "unknown" }, located: true, nonSource: false, categories };

  const { fileName } = declaration.getSourceFile();
  const targetRelPath = cache.toRelPath(fileName);
  if (targetRelPath === null || isNonSourceTarget(targetRelPath)) {
    return {
      outcome: { kind: "external" },
      located: true,
      nonSource: targetRelPath !== null,
      categories,
      target: buildTargetFacts(declaration, fileName, targetRelPath, null),
    };
  }

  const targetSymbolId = pinOracleSymbol(declaration, targetRelPath, symbolTableRef);
  return {
    outcome: { kind: "inProject", answer: { targetRelPath, targetSymbolId } },
    located: true,
    nonSource: false,
    categories,
    target: buildTargetFacts(declaration, fileName, targetRelPath, targetSymbolId),
  };
}

/**
 * The declaration facts decomposition reads. Populated in one place alongside
 * the outcome it belongs to, so a fact can never describe a different
 * declaration than the verdict was computed from.
 */
function buildTargetFacts(
  declaration: ts.Declaration,
  fileName: string,
  relPath: string | null,
  symbolId: string | null,
): OracleTargetFacts {
  return {
    relPath,
    symbolId,
    origin: classifyTargetOrigin(fileName, relPath),
    ...describeOracleDeclaration(declaration),
  };
}

/** The syntax-level half of the facts — everything decidable without a Program. */
export type OracleDeclarationShape = Pick<
  OracleTargetFacts,
  "shortName" | "declarationKind" | "declarationOnly" | "anonymousCallable"
>;

/**
 * What a declaration is, read off the AST alone. Split out from the rest of the
 * facts because origin and pinning need a Program and a symbol table while this
 * needs neither, which is what makes the shape rules testable against parsed
 * snippets rather than against a whole indexed corpus.
 */
export function describeOracleDeclaration(declaration: ts.Declaration): OracleDeclarationShape {
  const shortName = declarationShortName(declaration);
  return {
    shortName,
    declarationKind: ts.SyntaxKind[declaration.kind],
    declarationOnly: isDeclarationOnly(declaration),
    anonymousCallable: isAnonymousCallable(declaration, shortName),
  };
}

/**
 * Where the declaration lives. `node_modules` is UNDER the repo root, so
 * `toRelPath` happily returns a relative path for it and the existing
 * `nonSource` counter cannot tell a package's `.d.ts` from the project's own
 * `build/` output. Origin makes that distinction, which is the whole basis of
 * telling a builtin phantom from a measurement artifact.
 */
function classifyTargetOrigin(fileName: string, relPath: string | null): OracleTargetOrigin {
  if (/(^|\/)lib\.[a-z0-9_.]*d\.ts$/.test(fileName)) return "defaultLib";
  if (fileName.includes("/node_modules/")) return "externalPackage";
  if (relPath === null) return "outsideRepo";
  return isNonSourceTarget(relPath) ? "generatedInRepo" : "project";
}

/**
 * The name an edge could point at. An arrow function bound to a name
 * (`const run = () => {}`) HAS one and is deliberately not excused — only a
 * genuinely unnamed callable is.
 */
function declarationShortName(declaration: ts.Declaration): string | null {
  const named = declaration as ts.Declaration & { name?: ts.Node };
  if (named.name !== undefined && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))) {
    return named.name.text;
  }

  // A function TYPE carries no name of its own; the member it types does, and
  // that member is what an edge would name. Missing this reads every
  // `hydrate: (p) => void` interface member as anonymous and silently empties
  // the interface-vs-impl bucket.
  const { parent } = declaration;
  if (
    parent !== undefined &&
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return null;
}

/** A declaration site carrying no body: interface member, abstract, overload signature, ambient. */
function isDeclarationOnly(declaration: ts.Declaration): boolean {
  if (
    ts.isMethodSignature(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isCallSignatureDeclaration(declaration) ||
    ts.isConstructSignatureDeclaration(declaration) ||
    ts.isFunctionTypeNode(declaration)
  ) {
    return true;
  }

  const owner: ts.Node | undefined = declaration.parent;
  if (owner !== undefined && (ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner))) return true;

  const { body } = declaration as ts.Declaration & { body?: ts.Node };
  if (isSignatureLike(declaration) && body === undefined) return true;

  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword) ?? false;
}

/** A callable with nothing to name it by — an inline closure, or a callback parameter. */
function isAnonymousCallable(declaration: ts.Declaration, shortName: string | null): boolean {
  if (ts.isParameter(declaration)) return true;
  return (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && shortName === null;
}

/**
 * Callee declaration via the symbol table of the checker rather than the
 * selected signature — the path that covers plain function references and
 * re-exported bindings, where `getResolvedSignature` has nothing to select.
 */
function declarationViaSymbol(node: ts.CallExpression, checker: ts.TypeChecker): ts.Declaration | undefined {
  const nameNode = calleeNameNode(node);
  if (nameNode === null) return undefined;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0];
}

/** The identifier naming the callee — `fetch` in `repo.fetch(…)`, `run` in `run(…)`. */
function calleeNameNode(node: ts.CallExpression): ts.Identifier | null {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name;
  if (ts.isIdentifier(callee)) return callee;
  return null;
}

/**
 * Pin the checker's declaration to a project symbolId, the vocabulary the rest
 * of the graph is phrased in. Mirrors the fallback strategy's own pinning —
 * exact composed id, then short name narrowed to the declaring file — so a
 * symbol-level disagreement means the two sides genuinely picked different
 * declarations, not that the oracle composed the id differently.
 */
function pinOracleSymbol(
  declaration: ts.Declaration,
  targetRelPath: string,
  table: InMemoryGlobalSymbolTable,
): string | null {
  if (!isSignatureLike(declaration)) return null;
  const composed = composeSymbolId(declaration);
  if (composed === null) return null;

  const exact = table.lookup(composed.symbolId).filter((def) => def.relPath === targetRelPath);
  if (exact.length > 0) return exact[0].symbolId;

  const byShortName = table.lookupByShortName(composed.shortName).filter((def) => def.relPath === targetRelPath);
  return byShortName.length === 1 ? byShortName[0].symbolId : null;
}

function isSignatureLike(declaration: ts.Declaration): declaration is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isConstructorDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration) ||
    ts.isCallSignatureDeclaration(declaration) ||
    ts.isConstructSignatureDeclaration(declaration)
  );
}

/**
 * Which type-system features a call site exercises — the axis the whole report
 * exists to rank. Features are additive rather than exclusive: a call can be a
 * generic invoked on a union-typed receiver, and attributing it to one feature
 * would understate the other.
 */
function classifyTypeFeatures(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  signature: ts.Signature | undefined,
  declaration: ts.Declaration | undefined,
): string[] {
  const features: string[] = [];
  if (hasJsxAncestor(node)) features.push("jsx");
  if (isGenericCall(node, signature, declaration)) features.push("generic");
  if (isOverloadedCall(node, checker)) features.push("overload");
  if (receiverIsCallResult(node)) features.push("returnTypeInference");
  if (receiverIsUnion(node, checker)) features.push("unionNarrowing");
  if (targetIsStructural(declaration, checker)) features.push("structuralTyping");
  return features.length === 0 ? ["plain"] : features;
}

function hasJsxAncestor(node: ts.Node): boolean {
  for (let cursor: ts.Node | undefined = node; cursor !== undefined; cursor = cursor.parent) {
    if (
      ts.isJsxElement(cursor) ||
      ts.isJsxSelfClosingElement(cursor) ||
      ts.isJsxFragment(cursor) ||
      ts.isJsxExpression(cursor) ||
      ts.isJsxAttribute(cursor)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Explicit type arguments at the call site, or a signature/declaration carrying
 * type parameters — the three ways a call's target depends on instantiation.
 */
function isGenericCall(
  node: ts.CallExpression,
  signature: ts.Signature | undefined,
  declaration: ts.Declaration | undefined,
): boolean {
  if (node.typeArguments !== undefined && node.typeArguments.length > 0) return true;
  if (signature?.getTypeParameters()?.length) return true;
  return declaration !== undefined && isSignatureLike(declaration) && (declaration.typeParameters?.length ?? 0) > 0;
}

/** The callee resolves to a symbol carrying two or more signature declarations. */
function isOverloadedCall(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const nameNode = calleeNameNode(node);
  if (nameNode === null) return false;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const signatureDecls = (symbol?.declarations ?? []).filter(isSignatureLike);
  return signatureDecls.length >= 2;
}

/**
 * The receiver is itself a call's result — `build().run()`, `(await load()).run()`.
 * Resolving the member then requires the callee's RETURN type, which is the
 * cross-call inference case; no amount of AST shape-matching recovers it.
 */
function receiverIsCallResult(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  let receiver: ts.Expression = callee.expression;
  while (ts.isAwaitExpression(receiver) || ts.isNonNullExpression(receiver) || ts.isParenthesizedExpression(receiver)) {
    receiver = receiver.expression;
  }
  return ts.isCallExpression(receiver);
}

/**
 * The receiver's static type is a union of two or more real constituents.
 * `T | undefined` is excluded — optionality is ubiquitous and is not the
 * narrowing case Track B is about.
 */
function receiverIsUnion(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const type = checker.getTypeAtLocation(callee.expression);
  if (!type.isUnion()) return false;
  const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
  return type.types.filter((constituent) => (constituent.flags & nullish) === 0).length >= 2;
}

/**
 * The selected declaration lives on an interface or an inline type literal, or
 * on a symbol merged across files. Both are structural rather than nominal:
 * there is no single class the receiver's name could be matched against.
 */
function targetIsStructural(declaration: ts.Declaration | undefined, checker: ts.TypeChecker): boolean {
  if (declaration === undefined) return false;
  const owner = declaration.parent;
  if (owner === undefined) return false;
  if (ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner)) return true;

  const ownerName = ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner) ? owner.name : undefined;
  if (ownerName === undefined) return false;
  const ownerSymbol = checker.getSymbolAtLocation(ownerName);
  const files = new Set((ownerSymbol?.declarations ?? []).map((decl) => decl.getSourceFile().fileName));
  return files.size >= 2;
}

// ---------------------------------------------------------------------------
// Harness — walk the corpus, run both sides, diff.
// ---------------------------------------------------------------------------

/**
 * The symbol table the oracle pins declarations against. Module-scoped because
 * pinning happens deep inside the per-call query and threading it through every
 * frame buys nothing — the harness builds exactly one table per run.
 */
let symbolTableRef = new InMemoryGlobalSymbolTable();

const TS_EXTENSIONS = [".ts", ".tsx"] as const;
const SKIP_DIRECTORIES = new Set(["node_modules", "build", "dist", ".git", ".claude", "coverage", "website"]);

/** Every `.ts` / `.tsx` file under `dir`, repo-relative, sorted for determinism. */
async function collectSourceFiles(repoRoot: string, dir: string): Promise<RelPath[]> {
  const found: RelPath[] = [];

  const walk = async (absolute: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(child);
      } else if (TS_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) {
        found.push(relative(repoRoot, child).split(sep).join("/"));
      }
    }
  };

  await walk(dir);
  return found.sort();
}

/** Walker output for one file, or `null` when the file could not be parsed. */
function extractFile(
  repoRoot: string,
  relPath: RelPath,
  composer: DefaultSymbolIdComposer,
  factory: LanguageFactory,
): FileExtraction | null {
  const extension = relPath.endsWith(".tsx") ? ".tsx" : ".ts";
  const config = CODEGRAPH_LANGUAGES[extension];
  const { walker } = factory.create(config.language);
  if (!walker) return null;

  try {
    const code = readFileSync(join(repoRoot, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(config.loadParser());
    const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
    const chunks = collectSymbols(
      tree,
      (node) => walker.nameOf(node),
      config.scopeSeparator,
      config.disambiguateOverloads ?? false,
      composer,
    );
    return walker.walk({ tree, code, relPath, language: config.language, chunks });
  } catch {
    return null;
  }
}

/** `SymbolDefinition`s for a file, matching what the production sink upserts. */
function buildSymbolDefs(extraction: FileExtraction): SymbolDefinition[] {
  return extraction.chunks.map((chunk) => ({
    symbolId: chunk.symbolId,
    fqName: chunk.symbolId,
    shortName: lastSegment(chunk.symbolId),
    relPath: extraction.relPath,
    scope: chunk.scope,
  }));
}

interface RunCounters {
  files: number;
  parseFailures: number;
  callSites: number;
  dispatchSkipped: number;
  programUnavailable: number;
  nodeNotLocated: number;
  checkerExternal: number;
  /** Of `checkerExternal`, those inside the repo but not source — the artifact probe. */
  checkerExternalNonSource: number;
  checkerUnknown: number;
}

interface OracleRunResult {
  rows: OracleRow[];
  counters: RunCounters;
}

/**
 * Two passes, mirroring production: build the whole symbol table first, then
 * resolve — a call in the first file routinely targets the last one.
 */
async function runOracle(repoRoot: string, targetDir: string, limit: number, quiet: boolean): Promise<OracleRunResult> {
  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory();
  const resolver = new TSCallResolver(loadTsConfig(repoRoot), "strict", repoRoot);
  const cache = resolver.programCache;
  if (cache === null) {
    throw new Error(
      "TSCallResolver built no program cache — unset CODEGRAPH_TS_TYPECHECKER to enable the type checker.",
    );
  }

  symbolTableRef = new InMemoryGlobalSymbolTable();
  const counters: RunCounters = {
    files: 0,
    parseFailures: 0,
    callSites: 0,
    dispatchSkipped: 0,
    programUnavailable: 0,
    nodeNotLocated: 0,
    checkerExternal: 0,
    checkerExternalNonSource: 0,
    checkerUnknown: 0,
  };

  // Pass 1 — symbol table plus the run-global class hierarchy the chain reads.
  const files = (await collectSourceFiles(repoRoot, targetDir)).slice(0, limit);
  const extractions: FileExtraction[] = [];
  const classExtends: Record<string, string> = {};

  for (const relPath of files) {
    const extraction = extractFile(repoRoot, relPath, composer, factory);
    if (extraction === null) {
      counters.parseFailures++;
      continue;
    }
    symbolTableRef.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    extractions.push(extraction);
    counters.files++;
  }

  if (!quiet) process.stderr.write(`pass 1: ${counters.files} files, ${symbolTableRef.size()} symbols\n`);

  // Pass 2 — both answers per call site.
  const rows: OracleRow[] = [];
  let done = 0;

  for (const extraction of extractions) {
    const handle = cache.acquire(extraction.relPath);
    if (handle === null) counters.programUnavailable++;

    for (const chunk of extraction.chunks) {
      const ctx = buildCallContext(extraction, chunk, classExtends);
      for (const call of chunk.calls ?? []) {
        counters.callSites++;
        if (call.dispatch !== undefined) {
          counters.dispatchSkipped++;
          continue;
        }

        const chainTarget = resolver.resolve(call, ctx);
        const chain: OracleAnswer | null = chainTarget
          ? { targetRelPath: chainTarget.targetRelPath, targetSymbolId: chainTarget.targetSymbolId }
          : null;

        const probe = handle === null ? NO_ORACLE : queryTypeChecker(handle, cache, call);
        if (handle !== null && !probe.located) counters.nodeNotLocated++;
        if (probe.outcome.kind === "external") {
          counters.checkerExternal++;
          if (probe.nonSource) counters.checkerExternalNonSource++;
        }
        if (probe.located && probe.outcome.kind === "unknown") counters.checkerUnknown++;

        rows.push({
          relPath: extraction.relPath,
          startLine: call.startLine,
          callText: call.callText,
          receiverKind: classifyReceiverKind(call, chunk.localBindings),
          categories: probe.categories,
          verdict: diffResolution(chain, probe.outcome),
          ...(chain !== null && { chain }),
          ...(probe.target !== undefined && { target: probe.target }),
        });
      }
    }

    done++;
    if (!quiet && done % 25 === 0) {
      process.stderr.write(`pass 2: ${done}/${extractions.length} files, ${rows.length} call sites\n`);
    }
  }

  return { rows, counters };
}

/**
 * The seven fields the TypeScript strategies actually read, verified against
 * `strategies/*.ts` rather than assumed. The remaining `CallContext` fields are
 * Ruby-only (ivars, associations, Zeitwerk ancestry) and populating them here
 * would be noise pretending to be fidelity.
 */
function buildCallContext(
  extraction: FileExtraction,
  chunk: FileExtraction["chunks"][number],
  classExtends: Record<string, string>,
): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: extraction.imports,
    symbolTable: symbolTableRef,
    classFieldTypes: extraction.classFieldTypes,
    localBindings: chunk.localBindings,
    classExtends,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  repoRoot: string;
  target: string;
  limit: number;
  json: string | null;
  /** Mismatch rows carried per verdict into the JSON artifact. */
  samples: number;
  quiet: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repoRoot = resolvePath(read("--repo-root") ?? process.cwd());
  return {
    repoRoot,
    target: resolvePath(repoRoot, read("--target") ?? "src"),
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    json: read("--json") ?? null,
    samples: Number(read("--samples") ?? 25),
    quiet: argv.includes("--quiet"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const { rows, counters } = await runOracle(options.repoRoot, options.target, options.limit, options.quiet);

  const byFeature = tallyBy(rows, (row) => row.categories);
  const byReceiver = tallyBy(rows, (row) => [row.receiverKind]);
  const priorities = flagTrackBPriorities(byFeature);
  const uncovered = findUncoveredCategories(byFeature, TYPE_FEATURE_CATEGORIES);
  const decomposedByFeature = decomposeOracleMismatches(rows, (row) => row.categories);
  const [decomposedOverall] = decomposeOracleMismatches(rows, () => ["all call sites"]);

  const out: string[] = [
    "",
    `TS codegraph type-checker oracle — ${relative(options.repoRoot, options.target) || "."} @ ${options.repoRoot}`,
    `files ${counters.files} (parse failures ${counters.parseFailures}) · call sites ${counters.callSites} · scored ${rows.length}`,
    `skipped: dispatch ${counters.dispatchSkipped} · no program ${counters.programUnavailable} · node not located ${counters.nodeNotLocated}`,
    `checker external ${counters.checkerExternal} (of which non-source in-repo ${counters.checkerExternalNonSource}) · unknown ${counters.checkerUnknown}`,
    `elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`,
    "",
    formatOracleTable("BY TYPE FEATURE (rows overlap — a call site can carry several)", byFeature),
    "",
    formatOracleTable("BY RECEIVER KIND (partition — each call site counted once)", byReceiver),
    "",
  ];

  out.push("PRIORITY FOR TRACK B");
  if (priorities.length === 0) {
    out.push("  none — no category clears both the evidence floor and the mismatch threshold");
  } else {
    for (const priority of priorities) {
      out.push(
        `  ${priority.label}: ${(priority.mismatchRate * 100).toFixed(1)}% mismatch over ${priority.oracle} ` +
          `checker answers (missed ${priority.missed}, wrongFile ${priority.wrongFile})`,
      );
    }
  }
  const phantomHeavy = [...byFeature].filter((t) => t.phantom > 0).sort((a, b) => b.phantom - a.phantom);
  out.push("", "PRECISION — in-project edges the checker says leave the project");
  if (phantomHeavy.length === 0) {
    out.push("  none — the chain never claimed an in-project target for a provably external call");
  } else {
    for (const tally of phantomHeavy) {
      out.push(
        `  ${tally.label}: ${tally.phantom} phantom of ${tally.external} external (${(tally.phantomRate * 100).toFixed(1)}%)`,
      );
    }
  }

  out.push(
    "",
    formatDecompositionTable("DECOMPOSED MISMATCHES BY TYPE FEATURE (raw counts split by reason)", decomposedByFeature),
    "",
    "TRUE DEFECT RESIDUAL — what is left after reconciling agreement and unmodellable targets",
  );
  if (decomposedOverall === undefined) {
    out.push("  none — the chain and the checker agree on every scored call site");
  } else {
    const { wrongFile, missed, phantom } = decomposedOverall;
    out.push(
      `  wrongFile ${wrongFile.total} raw → ${wrongFile.defect} defects ` +
        `(interface-vs-impl ${wrongFile.interfaceVsImpl}, declaration-site path ${wrongFile.declarationSitePath})`,
      `  missed ${missed.total} raw → ${missed.defect} defects ` +
        `(anonymous callable ${missed.anonymousCallable}, unpinned target ${missed.unpinnedTarget})`,
      `  phantom ${phantom.total} raw → ${phantom.defect} fabricated edges ` +
        `(builtin ${phantom.builtinMember}, external package ${phantom.externalPackageMember}; ` +
        `arguable external-interface ${phantom.externalInterfaceMatch}, artifact ${phantom.generatedInRepo})`,
    );
  }

  if (uncovered.length > 0) {
    out.push("", `NO COVERAGE ON THIS CORPUS: ${uncovered.join(", ")} — this corpus cannot rank those tracks`);
  }
  out.push("");

  process.stdout.write(out.join("\n"));

  if (options.json !== null) {
    // Concrete call sites per mismatch kind — a rate says which case to work on,
    // a sample says where to start reading.
    const sample = (verdict: OracleVerdict): OracleRow[] =>
      rows.filter((row) => row.verdict === verdict).slice(0, options.samples);
    const payload = {
      counters,
      byFeature,
      byReceiver,
      priorities,
      uncovered,
      decomposedOverall,
      decomposedByFeature,
      decomposedByReceiver: decomposeOracleMismatches(rows, (row) => [row.receiverKind]),
      samples: { missed: sample("missed"), wrongFile: sample("wrongFile"), phantom: sample("phantom") },
    };
    writeFileSync(options.json, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`wrote ${options.json}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
