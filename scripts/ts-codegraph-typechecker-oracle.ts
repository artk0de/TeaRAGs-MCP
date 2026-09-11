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
 * MEASUREMENT CUTOVER — 2026-08-16, bd tea-rags-mcp-2mvc2. Four of the
 * harness's own defects were fixed at once, and each moves counts that were
 * never about the resolver. EVERY COUNT FROM BEFORE THAT COMMIT IS
 * INCOMPARABLE WITH COUNTS FROM AFTER IT — the corpus itself changed, not only
 * the verdicts computed over it.
 *
 *   - THE CORPUS WAS NOT PRODUCTION'S. The walk filtered on `SKIP_DIRECTORIES`
 *     alone: no `.gitignore`, and none of the codegraph exclusion layer. So the
 *     harness scored files the resolver never sees. On taxdome, `.gitignore`
 *     line 132 excludes `app/javascript/api/codegen/__generated__/**\/*.ts`,
 *     and 1,344 of the 1,723 baseline `wrongFile` rows — 78.0% — were
 *     generated API clients; roughly 173 more were test files, leaving ~206
 *     (12%) production-visible. Both layers now come from production's own
 *     definitions (`BUILTIN_IGNORE_PATTERNS` plus the ignore files
 *     `FileScanner` reads, then `buildCodegraphExclusionFilter`), and the two
 *     excluded populations are reported separately so the drop is auditable
 *     rather than silent. This is also what reconciles the harness with the
 *     live run: the oracle read `localVar` at 864 mismatches of 1,014 while
 *     `prime` reported 38 of 543, and the generated files are the difference.
 *
 *   - EXTERNAL SYMMETRY. The checker branch tested only `build/ | dist/ |
 *     .d.ts` for "not project source" while the chain branch also tested
 *     `node_modules/`. A dependency shipping `.d.mts` / `.d.cts` typings
 *     (zustand, msw, zod, openai) therefore scored as IN-PROJECT ground truth,
 *     and every chain decline against it read as a recall gap. Both sides now
 *     ask `isOutsideProjectSource`, which covers the whole `node_modules`
 *     segment (nested workspace copies included) and every declaration-file
 *     suffix. On taxdome this removed 812 `missed` and 237 `wrongFile`, and
 *     with them the `structuralTyping` category's 91.3% mismatch rate — that
 *     rate was measuring package typings, not structural typing.
 *   - THE `.js` BLIND SPOT. The walk collected `.ts` / `.tsx` only, so a
 *     TypeScript call into a `.js` / `.jsx` declaration hit a symbol table that
 *     had never heard of the target and scored `missed` / `unpinnedTarget`.
 *     Production indexes those extensions (`CODEGRAPH_LANGUAGES` maps them to
 *     javascript) into ONE cross-language symbol table per run. The walk now
 *     does the same. Their own call sites are still NOT scored — that would
 *     diff the JavaScript resolver against a chain built from `TSCallResolver`.
 *   - THE ORACLE'S OWN BLIND SPOT. `nodeNotLocated` was 28.1% of taxdome's
 *     call sites (53,852, 96% of them `bareCall`), i.e. more than a quarter of
 *     the corpus carried no ground truth at all. The cause was not a defect in
 *     `findCallExpression`: the walker emits `CallRef`s for THREE AST families
 *     and only one of them is a `ts.CallExpression`. A JSX component tag and a
 *     `new` expression are different node kinds, and the coordinates the walker
 *     records for them (`member` = tag name, `member` = "constructor") are not
 *     callee names. Both are located now — JSX through the production
 *     strategy's own `findJsxTagName`, `new` through a harness-local finder,
 *     since production resolves `new` without the checker and has no second
 *     implementation to drift from. What remains unlocatable is reported by
 *     SHAPE rather than as one opaque number; see {@link OracleUnlocatedShape}.
 *
 * MEASUREMENT CUTOVER — 2026-08-17, bd tea-rags-mcp-0w1py. Call sites naming a
 * callable VALUE now carry ground truth, so the SCORED SET GREW and every
 * verdict total moved with it. Counts from before this commit are comparable
 * only in the sense a smaller sample is: nothing about the resolver changed,
 * and no verdict was recomputed differently — sites that used to score
 * `bothUnresolved` / `chainOnly` for want of an oracle now score for real.
 *
 * The blind spot was the QUERY, not the finders. `arr.map(this.tick)` puts an
 * edge at the ARGUMENT's coordinate and `f.bind(x)` records the function the
 * walker unwrapped TO, so neither coordinate holds a call-like node and
 * `getResolvedSignature` — which needs one — could not be asked. Both are
 * answered by asking the checker for the referenced expression's SYMBOL
 * instead; see {@link referencesCallableValue} for which shapes qualify and
 * {@link queryValueReference} for why the feature axes narrow there.
 *
 * Measured across the cutover: on taxdome `nodeNotLocated` 426 → 259
 * (`methodReference` 86 → 0, `coordinateMiss` 322 → 241, the 81 unwrapped
 * invoker sites), `wrongFile` defects 1479 → 1489, `missed` defects 1004 →
 * 1004, `phantom` defects 318 → 318. On this repo's `src` 139 → 72
 * (`methodReference` 16 → 0, `coordinateMiss` 96 → 45) with the three defect
 * residuals — 25 / 3 / 0 — identical on both sides. The +10 taxdome
 * `wrongFile` are new evidence, not a regression: they are the first verdicts
 * these sites have ever received.
 *
 * `dynamicSend` and `dynamicImport` stay unlocated on purpose. A computed
 * callee names no value to resolve — the walker kept the literal edge precisely
 * because there was nothing to unwrap to — and a dynamic import targets a
 * MODULE, which the import-edge channel owns.
 *
 * `phantom` changed meaning earlier, on 2026-08-10, in the commit carrying bd
 * tea-rags-mcp-ffju3 (`git log --grep=ffju3 -- scripts/`). RAW PHANTOM COUNTS
 * FROM BEFORE THAT COMMIT ARE NOT COMPARABLE WITH COUNTS FROM AFTER IT. The
 * external branch of
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
 * own `composeSymbolId`, and node lookup its own `findCallExpression` and
 * `findJsxTagName`, for the same reason — the Ruby harness's header records a
 * real measurement bug caused by a hand-copied helper drifting from the
 * original. What is deliberately NOT shared is the QUERY: the oracle asks
 * `getResolvedSignature` about the located node even where production's JSX
 * pass asks `getSymbolAtLocation` about the tag, because sharing the coordinate
 * keeps the two sides pointed at one call site while sharing the question would
 * make the diff a tautology.
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

import ignore, { type Ignore } from "ignore";
import Parser from "tree-sitter";
import ts from "typescript";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  RelPath,
  SymbolDefinition,
} from "../src/core/contracts/types/codegraph.js";
import { BUILTIN_IGNORE_PATTERNS } from "../src/core/domains/ingest/pipeline/ignore-defaults.js";
import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import { loadTsConfig, TSCallResolver } from "../src/core/domains/language/typescript/index.js";
import {
  composeSymbolId,
  findCallExpression,
} from "../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import { findJsxTagName } from "../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-jsx-component.js";
import type {
  TSProgramCache,
  TSProgramHandle,
} from "../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { FUNCTION_INVOKER_MEMBERS } from "../src/core/domains/language/typescript/walker/walker.js";
import { buildCodegraphExclusionFilter } from "../src/core/domains/trajectory/codegraph/exclusion.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { classifyReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { lastSegment } from "../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { fileIsInertForExtraction } from "../src/core/infra/extraction-fast-path.js";
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
  /**
   * What the CHAIN emitted, independent of what the checker concluded. Every
   * verdict bucket is a comparison, so none of them can see a change that moves
   * edges into or out of the checker's blind spots — and 2307 of these call
   * sites sit in one (`checkerUnknown` + `nodeNotLocated`).
   */
  chainOutput: ChainOutput;
  /** What the chain answered, carried so mismatch samples are actionable. */
  chain?: OracleAnswer;
  /** What the checker's declaration is. Absent when the checker located none. */
  target?: OracleTargetFacts;
  /**
   * Why the oracle had no node to ask about. Present exactly on the rows that
   * carry NO ground truth for that reason, so the harness's own blind spot is
   * readable off the rows rather than only as an aggregate counter.
   */
  unlocatedShape?: OracleUnlocatedShape;
}

/** The chain's own answer shape: a pinned symbol, a bare file, or nothing. */
export type ChainOutput = "pinned" | "fileOnly" | "none";

/**
 * The chain's raw output, the number no verdict table reports.
 *
 * bd tea-rags-mcp-pmxuv flipped one strategy to `continue`, watched every
 * oracle verdict improve, and only caught a 156-edge (2.0%) loss by
 * hand-instrumenting a throwaway copy of this harness. That instrumentation
 * lives here now so the next such change cannot hide.
 */
export interface ChainOutputTally {
  /** Call sites the chain resolved to anything. */
  edges: number;
  /** Of those, edges carrying no `targetSymbolId` — a SUBSET of `edges`. */
  fileOnly: number;
  /** Call sites the chain declined. */
  unresolved: number;
}

export function tallyChainOutput(rows: readonly OracleRow[]): ChainOutputTally {
  const tally: ChainOutputTally = { edges: 0, fileOnly: 0, unresolved: 0 };
  for (const row of rows) {
    if (row.chainOutput === "none") {
      tally.unresolved++;
      continue;
    }
    tally.edges++;
    if (row.chainOutput === "fileOnly") tally.fileOnly++;
  }
  return tally;
}

/** Call sites the oracle could not locate a node for, by shape. */
export type OracleUnlocatedTally = Record<OracleUnlocatedShape, number>;

export function tallyUnlocatedShapes(rows: readonly OracleRow[]): OracleUnlocatedTally {
  const tally = Object.fromEntries(ORACLE_UNLOCATED_SHAPES.map((shape) => [shape, 0])) as OracleUnlocatedTally;
  for (const row of rows) {
    if (row.unlocatedShape !== undefined) tally[row.unlocatedShape]++;
  }
  return tally;
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
 *
 * BOTH sides of the diff ask this one question (bd tea-rags-mcp-2mvc2). They
 * used not to: the checker branch tested `isNonSourceTarget` alone, so a
 * dependency's `.d.mts` was in-project ground truth on one side and external on
 * the other, and the asymmetry manufactured recall gaps out of package typings.
 */
function isOutsideProjectSource(relPath: string): boolean {
  return isDependencyPath(relPath) || isNonSourceTarget(relPath);
}

/**
 * Anything under a `node_modules` SEGMENT, nested workspace copies included —
 * the same whole-segment test `TSProgramCache#toProjectSourceRelPath` applies,
 * so the harness cannot call a dependency in-project that production would not.
 * A path merely NAMED like one (`src/node_modules_helper.ts`) is project code.
 */
function isDependencyPath(relPath: string): boolean {
  return relPath === "node_modules" || relPath.startsWith("node_modules/") || relPath.includes("/node_modules/");
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
export type OracleWrongFileReason = "interfaceVsImpl" | "declarationSitePath" | "inheritedConstructor" | "defect";

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
 * A `super(...)` site where the two sides disagree only about HOW FAR UP the
 * hierarchy to point (bd tea-rags-mcp-2mvc2).
 *
 * `class DuckDBError extends InfraError` calling `super(…)` where `InfraError`
 * declares no constructor of its own: the checker names the declaration that
 * actually runs, three classes up in `TeaRagsError`, while the chain names the
 * IMMEDIATE parent's synthetic `constructor` — the node the chunker emitted and
 * the one the graph models the hierarchy with. Both edges are well-formed and
 * they describe the same call; counting the difference as a fabricated target
 * would have added 38 phantom defects to this repo's residual the day
 * `super()` first became locatable, with nothing about the resolver changed.
 *
 * Deliberately narrow. It fires only on a `super` receiver — the one idiom
 * whose target is reached through inheritance rather than through a name — so a
 * `new Foo()` answered with `Bar#constructor`, which IS a wrong target, keeps
 * counting as a defect.
 */
function isInheritedConstructorHop(row: OracleRow): boolean {
  return (
    row.receiverKind === "super" &&
    row.target?.declarationKind === "Constructor" &&
    row.chain?.targetSymbolId !== null &&
    row.chain !== undefined &&
    lastSegment(row.chain.targetSymbolId ?? "") === "constructor"
  );
}

/**
 * Reconcile one `wrongFile`. Interface-versus-implementation is agreement
 * expressed differently, not a heuristic firing wrong.
 */
export function reconcileOracleWrongFile(row: OracleRow): OracleWrongFileReason {
  const { target } = row;
  if (target === undefined) return "defect";
  if (isInheritedConstructorHop(row)) return "inheritedConstructor";
  if (!namesTheSameMember(row.chain, target)) return "defect";
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
  wrongFile: {
    total: number;
    interfaceVsImpl: number;
    declarationSitePath: number;
    inheritedConstructor: number;
    defect: number;
  };
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
    wrongFile: { total: 0, interfaceVsImpl: 0, declarationSitePath: 0, inheritedConstructor: 0, defect: 0 },
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
    "superCtor",
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
          d.wrongFile.inheritedConstructor,
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
  /** Why no node was located. Present exactly when `located` is `false`. */
  unlocatedShape?: OracleUnlocatedShape;
}

const NO_ORACLE: OracleQueryResult = {
  outcome: { kind: "unknown" },
  located: false,
  nonSource: false,
  categories: ["plain"],
};

/**
 * Every declaration-file suffix TypeScript recognises. `.d.ts` alone is not the
 * set: a package shipping ESM or CJS typings writes `.d.mts` / `.d.cts`, and
 * those do not END with `.d.ts` (bd tea-rags-mcp-2mvc2).
 */
const DECLARATION_FILE_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"] as const;

/**
 * Compiled and generated outputs that are inside the repo root but are not
 * source. `toRelPath` accepts them because they are under the root, and a
 * declaration resolved into `build/` would then be scored against the `src/`
 * file the chain names — a `wrongFile` that is purely an artifact of the
 * worktree having been built. They are external for measurement purposes.
 */
function isNonSourceTarget(relPath: string): boolean {
  return (
    relPath.startsWith("build/") ||
    relPath.startsWith("dist/") ||
    DECLARATION_FILE_SUFFIXES.some((suffix) => relPath.endsWith(suffix))
  );
}

/**
 * Why the harness could not put a `CallRef` on a node the checker will answer
 * about — the taxonomy of its OWN blind spot (bd tea-rags-mcp-2mvc2).
 *
 * On taxdome this was 28.1% of all call sites reported as one opaque
 * `nodeNotLocated` counter, which is not a number anybody can act on: it mixes
 * shapes the harness simply never looked for with coordinates that genuinely
 * failed to line up. Split by shape it says which, and the first two are now
 * located rather than counted.
 *
 *   - `jsxTag` — `<Card />`. A `ts.JsxSelfClosingElement`, not a
 *     `CallExpression`; located via the production pass's `findJsxTagName`.
 *   - `constructorCall` — `new Repo()`. A `ts.NewExpression`, and the walker
 *     records `member: "constructor"`, which is nobody's callee name; located
 *     via {@link findNewExpression}.
 *   - `superCall` — `super(...)`. A `CallExpression` whose callee is the
 *     `super` keyword rather than an identifier, so `callSiteAt` cannot index
 *     it; located via {@link findSuperCall}. The walker re-shapes it to
 *     `{ receiver: "super", member: "constructor" }` (bd tea-rags-mcp-3a84),
 *     which is why this arm has to be tested BEFORE `constructorCall` —
 *     otherwise every `super()` reads as a `new` expression and the harness
 *     hunts for a `new super()` that cannot exist.
 *   - `dynamicSend` — `obj[key]()`, `registry[k].call(x)`. The walker tags
 *     these itself and production drops them from the resolve denominator; the
 *     checker cannot name a target for a computed callee either.
 *   - `dynamicImport` — `import("./x")`. The walker files it under member
 *     `import`, and the compiler's `ImportKeyword` is not an identifier, so
 *     `callSiteAt` never indexed it. Deliberately NOT located: the target of a
 *     dynamic import is a MODULE, and `getResolvedSignature` has no signature
 *     to select. The import-edge channel owns these, not the call channel.
 *   - `methodReference` — `arr.map(this.tick)`. The walker emits an edge for a
 *     method passed as a VALUE, at the argument's own coordinate. There is no
 *     call-like node there at all — `callText` carries no `(` — so this is a
 *     ground-truth gap by construction, not a lookup failure.
 *   - `coordinateMiss` — everything else: a real call whose `(line, member)`
 *     the index has no entry for. This is the only bucket that would indicate a
 *     defect in the finders, and keeping it as the small residual is what makes
 *     the other six auditable. On this repo's `src` it is 15 of 15,466 sites,
 *     dominated by `f.bind(x)` — the walker unwraps the invoker and records the
 *     UNWRAPPED member, while the line's only indexed callee name is `bind`.
 */
export type OracleUnlocatedShape =
  | "jsxTag"
  | "constructorCall"
  | "superCall"
  | "dynamicSend"
  | "dynamicImport"
  | "methodReference"
  | "coordinateMiss";

export const ORACLE_UNLOCATED_SHAPES: readonly OracleUnlocatedShape[] = [
  "jsxTag",
  "constructorCall",
  "superCall",
  "dynamicSend",
  "dynamicImport",
  "methodReference",
  "coordinateMiss",
] as const;

/**
 * Which shape a `CallRef` the harness failed to locate has. Read off the ref
 * alone — the walker records enough to decide every bucket without re-parsing,
 * and a classifier that needed the AST could not run on the failure path.
 *
 * Order is precedence, worst-understood last. `jsxTag` outranks the rest
 * because a dotted tag (`<UI.Panel />`) carries a receiver that would otherwise
 * read as an ordinary member call.
 */
export function classifyUnlocatedCallShape(call: CallRef): OracleUnlocatedShape {
  if (call.jsx === true) return "jsxTag";
  if (call.receiver === "super" || call.member === "super") return "superCall";
  if (call.member === "constructor") return "constructorCall";
  if (call.dynamicSend === true) return "dynamicSend";
  // `import` is a reserved word, so no project function can be filed under it.
  if (call.member === "import") return "dynamicImport";
  return call.callText.includes("(") ? "coordinateMiss" : "methodReference";
}

/**
 * The call-like node one `CallRef` names, or `null` when the harness has none
 * to offer the checker.
 *
 * Three AST families, because the walker emits `CallRef`s for three and only
 * one of them is a `ts.CallExpression`. `ts.CallLikeExpression` is the type
 * `getResolvedSignature` accepts, so all three reach the same query.
 */
function locateCallLike(sourceFile: ts.SourceFile, call: CallRef): ts.CallLikeExpression | null {
  if (call.jsx === true) {
    const tagName = findJsxTagName(sourceFile, call.startLine, call.member);
    return tagName === null ? null : (tagName.parent as ts.JsxOpeningLikeElement);
  }
  if (call.member === "constructor" && call.receiver !== null) {
    return call.receiver === "super"
      ? findSuperCall(sourceFile, call.startLine)
      : findNewExpression(sourceFile, call.startLine, call.receiver);
  }
  return findCallExpression(sourceFile, call.startLine, call.member);
}

/** `f.call(…)` / `f.apply(…)` / `f.bind(…)` written out at a call site. */
const FUNCTION_INVOKER_CALL = /\.(?:call|apply|bind)\s*\(/;

/**
 * Does this `CallRef` name a callable VALUE rather than a call expression (bd
 * tea-rags-mcp-0w1py)?
 *
 * Two shapes reach the same answer, and the walker produced both by recording
 * something other than a callee at a coordinate:
 *
 *   - `methodReference` — `arr.map(this.tick)`. The edge is emitted at the
 *     ARGUMENT's coordinate, and an argument is not a call. There is no
 *     call-like node to select a signature from, and there never was one to
 *     find: the ground truth here is the symbol `this.tick` resolves to.
 *   - the invoker UNWRAP — `f.bind(x)`, `handler.run.call(handler)`. The walker
 *     drops the literal `.bind` edge and records the function that will run
 *     ({@link FUNCTION_INVOKER_MEMBERS}), so the coordinate's only indexed
 *     callee name is `bind` and `callSiteAt` never matches the member. Same
 *     answer, same reason: the RECEIVER of the invoker is a value reference.
 *
 * Everything else is declined on purpose, so the residual keeps meaning what
 * its docblock says. A `dynamicSend` invoker (`registry[k].call(x)`) has no
 * static name to resolve — the walker kept the literal edge precisely because
 * there was nothing to unwrap to. And an ordinary `coordinateMiss`
 * (`handleSubmit(onSubmit)()`, an IIFE) IS a call the finders should have
 * placed; answering it off some identifier that happens to share the line would
 * hide the one bucket that indicates a finder defect.
 */
export function referencesCallableValue(call: CallRef): boolean {
  const shape = classifyUnlocatedCallShape(call);
  if (shape === "methodReference") return true;
  if (shape !== "coordinateMiss") return false;
  return FUNCTION_INVOKER_CALL.test(call.callText) && !FUNCTION_INVOKER_MEMBERS.has(call.member);
}

/** Every identifier of one SourceFile, keyed `${line}:${text}`. */
const valueReferenceIndexes = new WeakMap<ts.SourceFile, Map<string, ts.Identifier>>();

/**
 * The identifier naming a callable value at `(startLine, member)` — `tick` in
 * `arr.map(this.tick)`, `f` in `f.bind(x)` — or `undefined` when the line
 * carries none (bd tea-rags-mcp-0w1py).
 *
 * Indexed per SourceFile for the reason {@link callSiteAt} is, and first-write-
 * wins in pre-order for the same reason too: the answer for a file never
 * changes between questions, and the outermost occurrence on a line is the one
 * a coordinate means. A property access contributes its `.name`, which is what
 * `getSymbolAtLocation` needs to reach the member rather than the receiver.
 *
 * Deliberately NOT restricted to non-callee positions. The finder is consulted
 * only after {@link locateCallLike} declined AND {@link referencesCallableValue}
 * claimed the site, so a callee identifier can only be reached by a call whose
 * own node was already unfindable — and answering that off the callee is the
 * right answer, not a coincidence.
 */
export function findValueReference(sourceFile: ts.SourceFile, startLine: number, member: string): ts.Identifier | null {
  let index = valueReferenceIndexes.get(sourceFile);
  if (index === undefined) {
    index = buildValueReferenceIndex(sourceFile);
    valueReferenceIndexes.set(sourceFile, index);
  }
  return index.get(`${startLine}:${member}`) ?? null;
}

function buildValueReferenceIndex(sourceFile: ts.SourceFile): Map<string, ts.Identifier> {
  const index = new Map<string, ts.Identifier>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const key = `${line}:${node.text}`;
      if (!index.has(key)) index.set(key, node);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return index;
}

/**
 * `new` and `super(...)` sites of one SourceFile, keyed by the coordinate the
 * WALKER records for each: `${line}:new:${constructorShortName}` and
 * `${line}:super`.
 *
 * One index for both because they are asked in the same breath and neither can
 * collide with the other's key space. Indexed rather than walked per call for
 * the reason {@link callSiteAt} is: the answer for a file never changes between
 * questions, and asking it per call site turns one traversal into thousands.
 * A `WeakMap` keyed on the SourceFile ties the index's lifetime to the parse
 * `TSProgramCache` owns, so a re-parse silently supersedes it.
 */
const constructorSiteIndexes = new WeakMap<ts.SourceFile, Map<string, ts.CallLikeExpression>>();

function constructorSiteAt(sourceFile: ts.SourceFile, key: string): ts.CallLikeExpression | null {
  let index = constructorSiteIndexes.get(sourceFile);
  if (index === undefined) {
    index = buildConstructorSiteIndex(sourceFile);
    constructorSiteIndexes.set(sourceFile, index);
  }
  return index.get(key) ?? null;
}

function buildConstructorSiteIndex(sourceFile: ts.SourceFile): Map<string, ts.CallLikeExpression> {
  const index = new Map<string, ts.CallLikeExpression>();

  const visit = (node: ts.Node): void => {
    const key = constructorSiteKey(sourceFile, node);
    if (key !== null && !index.has(key)) index.set(key, node as ts.CallLikeExpression);
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return index;
}

function constructorSiteKey(sourceFile: ts.SourceFile, node: ts.Node): string | null {
  const lineOf = (): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  if (ts.isNewExpression(node)) {
    const shortName = constructorShortName(node.expression);
    return shortName === null ? null : `${lineOf()}:new:${shortName}`;
  }
  // `super(...)` — a `CallExpression` whose callee is the keyword, so it carries
  // no callee name and `callSiteAt` never indexed it. A constructor body holds
  // at most one, so the line alone identifies it.
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return `${lineOf()}:super`;
  }
  return null;
}

/**
 * The `super(...)` call starting on `startLine`. `getResolvedSignature` answers
 * with the BASE class's constructor, which is exactly the edge the chain's
 * `super.X()` branch emits.
 */
function findSuperCall(sourceFile: ts.SourceFile, startLine: number): ts.CallLikeExpression | null {
  return constructorSiteAt(sourceFile, `${startLine}:super`);
}

/**
 * The `new` expression starting on `startLine` (1-based, matching
 * `CallRef.startLine`) whose constructor's own name is the last segment of
 * `receiverText` — `Foo` for both `new Foo()` and `new ns.SubNS.Foo()`, which
 * is the text the walker records as the receiver.
 *
 * Harness-local on purpose, unlike the two finders imported from production:
 * production resolves `new` through the tree-sitter capitalized-receiver
 * branch and never asks the checker about it, so there is no second
 * implementation here for this one to drift from.
 */
function findNewExpression(
  sourceFile: ts.SourceFile,
  startLine: number,
  receiverText: string,
): ts.CallLikeExpression | null {
  const wanted = receiverText.slice(receiverText.lastIndexOf(".") + 1);
  return constructorSiteAt(sourceFile, `${startLine}:new:${wanted}`);
}

/** Rightmost identifier of a `new` target — `Foo` in `new ns.Foo()`. */
function constructorShortName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text;
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

/**
 * The checker's answer for one call site, plus the type features it exercised.
 *
 * `getResolvedSignature` is the primary query — it names the concrete signature
 * the compiler selected, which is what overload and generic resolution turn on.
 * When it declines (a call through a value whose type has one call signature, a
 * direct reference to an imported function), the symbol path is the fallback:
 * resolve the callee identifier, unwrap an import alias, take its declaration.
 *
 * A JSX TAG INVERTS THAT ORDER, and the inversion is load-bearing
 * (bd tea-rags-mcp-2mvc2). A component written `const Layout: React.FC<Props>`
 * has no call signature of its own — the one the compiler selects is the
 * `(props: P): ReactNode` that `@types/react` declares on `FunctionComponent`.
 * Asking `getResolvedSignature` about `<Layout />` therefore answers
 * `node_modules/@types/react/index.d.ts`, and the chain's perfectly correct
 * `ui-kit/components/Layout/Layout.tsx` reads as a fabricated edge. Measured on
 * taxdome before the inversion: 30,354 such rows, a third of every edge the
 * chain emitted, all of them the harness naming a component's TYPE instead of
 * the component. What the tag references is the tag NAME's symbol, which is
 * what an edge points at and what production's JSX pass asks for too.
 */
function queryTypeChecker(handle: TSProgramHandle, cache: TSProgramCache, call: CallRef): OracleQueryResult {
  const node = locateCallLike(handle.sourceFile, call);
  if (node === null) return queryValueReference(handle, cache, call);

  const { checker } = handle;
  const signature = checker.getResolvedSignature(node);
  const declaration = ts.isJsxOpeningLikeElement(node)
    ? (declarationViaSymbol(node, checker) ?? signature?.declaration)
    : (signature?.declaration ?? declarationViaSymbol(node, checker));
  const categories = classifyTypeFeatures(node, checker, signature, declaration);

  return placeDeclaration(declaration, cache, categories);
}

/**
 * The checker's answer for a call site that names a callable VALUE — there is
 * no call-like node at its coordinate, so `getResolvedSignature` has no
 * signature to select and the symbol path is the ONLY path (bd
 * tea-rags-mcp-0w1py).
 *
 * On taxdome this was 86 `methodReference` sites plus the 81 `.call` / `.apply`
 * / `.bind` sites the walker unwrapped — 167 real call sites the harness
 * counted, diffed as `bothUnresolved` / `chainOnly`, and had no opinion about.
 * The resolver has always answered them; only the ORACLE was missing, so every
 * one was invisible to the verdict axis the report ranks work by.
 *
 * {@link referencesCallableValue} is what keeps this from swallowing the
 * residual: a site the finders merely FAILED on still lands in
 * `coordinateMiss`, where a rising count means a finder is broken.
 */
function queryValueReference(handle: TSProgramHandle, cache: TSProgramCache, call: CallRef): OracleQueryResult {
  const unlocated: OracleQueryResult = { ...NO_ORACLE, unlocatedShape: classifyUnlocatedCallShape(call) };
  if (!referencesCallableValue(call)) return unlocated;

  const reference = findValueReference(handle.sourceFile, call.startLine, call.member);
  if (reference === null) return unlocated;

  const { checker } = handle;
  const declaration = declarationOfIdentifier(reference, checker);
  // No signature was selected, so the feature axes that read one (generic,
  // overload, union narrowing, return-type inference) have nothing to say here
  // and claiming them would overstate what was measured. The two that read the
  // NODE and the DECLARATION still hold.
  const features: string[] = [];
  if (hasJsxAncestor(reference)) features.push("jsx");
  if (targetIsStructural(declaration, checker)) features.push("structuralTyping");

  return placeDeclaration(declaration, cache, features.length === 0 ? ["plain"] : features);
}

/**
 * Turn the declaration the checker named into the verdict-bearing outcome:
 * `unknown` when it named none, `external` when it lies outside project source,
 * `inProject` otherwise. One implementation for both query paths, so a call
 * site's placement can never depend on which of them located it.
 */
function placeDeclaration(
  declaration: ts.Declaration | undefined,
  cache: TSProgramCache,
  categories: string[],
): OracleQueryResult {
  if (declaration === undefined) return { outcome: { kind: "unknown" }, located: true, nonSource: false, categories };

  // A SYNTHESIZED declaration has no source file to place it in. The compiler
  // fabricates one when the signature it selected belongs to no written node —
  // an inferred `FunctionType` standing in for a component's props callback is
  // the shape observed (1 site in mastodon's 10,002). `getSourceFile()` is
  // typed as always returning, so this arm needs the cast to exist at all; it
  // reads as "the checker answered, and the answer names nowhere", which is
  // exactly `unknown` and NOT external — calling it external would let an
  // in-project chain answer on the same call score as a phantom.
  const declared = declaration.getSourceFile() as ts.SourceFile | undefined;
  if (declared === undefined) {
    return { outcome: { kind: "unknown" }, located: true, nonSource: false, categories };
  }
  const { fileName } = declared;
  const targetRelPath = cache.toRelPath(fileName);
  if (targetRelPath === null || isOutsideProjectSource(targetRelPath)) {
    const target = buildTargetFacts(declaration, fileName, targetRelPath, null);
    return {
      outcome: { kind: "external" },
      located: true,
      // Origin, not mere path-in-repo: `node_modules` is under the root too, so
      // the old `targetRelPath !== null` counted every package `.d.ts` as the
      // project's own generated output and the artifact probe read the whole
      // dependency surface (bd tea-rags-mcp-2mvc2).
      nonSource: target.origin === "generatedInRepo",
      categories,
      target,
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
  // A constructor carries no `name` node, but it HAS a name in the graph's
  // vocabulary — the chunker emits `Owner#constructor`, and the fallback
  // strategy's own `declarationShortName` says `"constructor"` here too.
  if (ts.isConstructorDeclaration(declaration)) return "constructor";
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
function declarationViaSymbol(node: ts.CallLikeExpression, checker: ts.TypeChecker): ts.Declaration | undefined {
  const nameNode = calleeNameNode(node);
  return nameNode === null ? undefined : declarationOfIdentifier(nameNode, checker);
}

/**
 * The declaration one identifier resolves to, import aliases unwrapped.
 *
 * Shared by the callee path above and the value-reference path (bd
 * tea-rags-mcp-0w1py), which differ only in WHICH identifier they hand over —
 * a callee name for one, the referenced expression for the other. Keeping the
 * unwrap in one place is why a method passed as a value and the same method
 * called outright resolve to the same declaration.
 */
function declarationOfIdentifier(nameNode: ts.Identifier, checker: ts.TypeChecker): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0];
}

/**
 * The identifier naming what is being invoked — `fetch` in `repo.fetch(…)`,
 * `run` in `run(…)`, `Repo` in `new Repo()`, `Card` in `<Card />`. The JSX and
 * `new` arms exist because both families reach this file now, and a callee
 * reader that only understood `CallExpression` would silently return `null` for
 * them, dropping the symbol fallback and the overload classification with it.
 */
function calleeNameNode(node: ts.CallLikeExpression): ts.Identifier | null {
  const callee = ts.isJsxOpeningLikeElement(node)
    ? node.tagName
    : ts.isCallExpression(node) || ts.isNewExpression(node)
      ? node.expression
      : null;
  if (callee === null) return null;
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
  node: ts.CallLikeExpression,
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
  node: ts.CallLikeExpression,
  signature: ts.Signature | undefined,
  declaration: ts.Declaration | undefined,
): boolean {
  const { typeArguments } = node as ts.CallLikeExpression & { typeArguments?: ts.NodeArray<ts.TypeNode> };
  if (typeArguments !== undefined && typeArguments.length > 0) return true;
  if (signature?.getTypeParameters()?.length) return true;
  return declaration !== undefined && isSignatureLike(declaration) && (declaration.typeParameters?.length ?? 0) > 0;
}

/** The callee resolves to a symbol carrying two or more signature declarations. */
function isOverloadedCall(node: ts.CallLikeExpression, checker: ts.TypeChecker): boolean {
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
function receiverIsCallResult(node: ts.CallLikeExpression): boolean {
  if (!ts.isCallExpression(node)) return false;
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
function receiverIsUnion(node: ts.CallLikeExpression, checker: ts.TypeChecker): boolean {
  if (!ts.isCallExpression(node)) return false;
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

/**
 * Extensions whose CALL SITES are diffed. The chain side of every row comes
 * from `TSCallResolver`, so scoring a `.js` file's calls would report the
 * TypeScript resolver's verdict on JavaScript — a different resolver's corpus.
 */
const SCORED_EXTENSIONS = [".ts", ".tsx"] as const;

/**
 * Extensions walked into the symbol table (bd tea-rags-mcp-2mvc2).
 *
 * Wider than {@link SCORED_EXTENSIONS} because production builds ONE
 * cross-language `GlobalSymbolTable` per run and `CODEGRAPH_LANGUAGES` maps all
 * four JavaScript extensions to a walker. Collecting `.ts` / `.tsx` alone gave
 * the harness a symbol table production never has: a TypeScript call into a
 * `.js` declaration found no node to pin, so the oracle answered `missed` with
 * reason `unpinnedTarget` for a target the graph does contain. Measured at ~11%
 * of mastodon's sampled gap. Both sides read this table — the chain pins
 * through `ctx.symbolTable` — so widening it is what makes the harness agree
 * with production, not a thumb on either scale.
 */
const SYMBOL_TABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

const SKIP_DIRECTORIES = new Set(["node_modules", "build", "dist", ".git", ".claude", "coverage", "website"]);

/** The ignore files the ingest scanner reads, in its order. */
const PROJECT_IGNORE_FILES = [
  ".gitignore",
  ".dockerignore",
  ".npmignore",
  ".contextignore",
  ".contextignore.local",
] as const;

/**
 * The two exclusion layers production applies before a file can carry a
 * codegraph node, kept apart so the harness can say WHICH one dropped a file
 * (bd tea-rags-mcp-2mvc2).
 *
 * The harness used to apply neither, and scored a corpus production never
 * indexes. On taxdome, `.gitignore` line 132 excludes
 * `app/javascript/api/codegen/__generated__/**\/*.ts`, and 1,344 of the 1,723
 * baseline `wrongFile` rows — 78.0% — were generated API clients; ~173 more
 * were test files, leaving ~206 (12%) production-visible. Every raw taxdome
 * count was inflated roughly 8x on that axis, and it is also what made the
 * oracle's `localVar` mismatch (864 of 1,014) irreconcilable with the live
 * resolve rate (38 of 543) — drop the generated files and the two agree.
 */
interface CorpusExclusionFilter {
  /** `.gitignore` and friends plus the ingest baseline — production never indexes these at all. */
  ingest: Ignore;
  /** Generated + test + per-language non-app globs — indexed for search, but no codegraph nodes. */
  codegraph: Ignore;
}

/**
 * Build both layers from production's own definitions rather than a local
 * pattern list — the same reason the node finders are imported rather than
 * copied. `FileScanner` owns the ingest order (baseline, then each ignore file,
 * then config patterns), and `buildCodegraphExclusionFilter` owns the codegraph
 * layer including whatever globs each `LanguageProvider` declares.
 *
 * Config-supplied `ignorePatterns` / `customIgnorePatterns` are the one part
 * not reproduced: they come from a bootstrap this harness does not build, and
 * a project that sets them is excluding MORE than modelled here, never less.
 *
 * `includeTests` lifts the codegraph layer's test + generated exclusions FOR
 * THE WALK ONLY (bd tea-rags-mcp-w205u, E4.0.4 / spec D5). Production excludes
 * them unconditionally and `buildCodegraphExclusionFilter` has no opt-out by
 * design, so the harness composes the remaining layer itself out of the same
 * exported pattern lists instead of asking production to become configurable.
 * A run with this on is a SEPARATE population — the symbol table grows, so
 * every short-name ambiguity moves — and never the baseline for any other
 * number.
 *
 * `skipIgnoreFiles` drops named entries of {@link PROJECT_IGNORE_FILES} from the
 * ingest layer, and is likewise a SEPARATE population. It exists for the one
 * question a Ruby-only corpus cannot answer: the mastodon bench corpus ships a
 * `.contextignore` excluding `/app/javascript/` and every `*.ts`, so its symbol
 * table holds three non-Ruby files and a cross-language namesake never appears
 * (bd tea-rags-mcp-kumq2). Skipping that one file — and only it, so `.gitignore`
 * still keeps `node_modules/` out — reproduces the polyglot table a Rails +
 * React repo actually builds.
 */
export async function buildCorpusExclusionFilter(
  repoRoot: string,
  factory: LanguageFactory,
  options: { includeTests?: boolean; skipIgnoreFiles?: readonly string[] } = {},
): Promise<CorpusExclusionFilter> {
  const ingest = ignore().add(BUILTIN_IGNORE_PATTERNS);
  const skipped = new Set(options.skipIgnoreFiles ?? []);
  for (const ignoreFile of PROJECT_IGNORE_FILES) {
    if (skipped.has(ignoreFile)) continue;
    try {
      ingest.add(readFileSync(join(repoRoot, ignoreFile), "utf8"));
    } catch {
      // Absent or unreadable ignore file — production skips it silently too.
    }
  }
  return {
    ingest,
    codegraph:
      options.includeTests === true
        ? buildLanguageOnlyExclusionFilter(factory)
        : buildCodegraphExclusionFilter({ customPatterns: [] }, factory),
  };
}

/**
 * The codegraph layer minus its test + generated patterns: every registered
 * language's own non-application globs and nothing else. Mirrors
 * `buildCodegraphExclusionFilter`'s language aggregation exactly, so the only
 * difference between the two populations is the two pattern lists.
 */
function buildLanguageOnlyExclusionFilter(factory: LanguageFactory): Ignore {
  const ig = ignore();
  for (const lang of factory.supported()) {
    const globs = factory.create(lang).codegraphExclusionGlobs;
    if (globs && globs.length > 0) ig.add(globs as string[]);
  }
  return ig;
}

/** The lowercased extension of a path, `""` when it has none. */
function extensionOf(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  return dot < 0 ? "" : relPath.slice(dot).toLowerCase();
}

/** A `.d.ts` / `.d.mts` / `.d.cts` file — typings, never a symbol-table source. */
function isDeclarationFile(name: string): boolean {
  return DECLARATION_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Is this file's own call set diffed, as opposed to only feeding the symbol table? */
export function isScoredSource(relPath: string): boolean {
  return SCORED_EXTENSIONS.some((ext) => extensionOf(relPath) === ext);
}

/** Files kept, and the excluded populations named by the layer that dropped them. */
export interface CorpusSelection {
  kept: RelPath[];
  /** Dropped by `.gitignore` and friends — production has no index entry at all. */
  ingestIgnored: number;
  /** Indexed for search, but generated / test / non-app code, so no codegraph node. */
  codegraphExcluded: number;
}

/**
 * Every walkable source file under `dir` production would build a codegraph
 * node for, repo-relative, sorted for determinism.
 *
 * Includes the JavaScript extensions: they populate the symbol table even
 * though {@link isScoredSource} keeps their call sites out of the diff.
 * Excludes whatever either production layer drops — a file the resolver never
 * sees cannot be evidence about the resolver, and counting it inflated
 * taxdome's `wrongFile` axis roughly 8x (see {@link CorpusExclusionFilter}).
 */
export async function collectSourceFiles(
  repoRoot: string,
  dir: string,
  exclude?: CorpusExclusionFilter,
  // Which extensions land in the symbol table. Defaults to this oracle's own
  // TS/JS set, so every existing caller is byte-identical. The Python oracle
  // passes `CODEGRAPH_LANGUAGES`'s keys instead — the exclusion LAYERS are what
  // corpus parity is about, and those are shared; the extension list is
  // language-specific by construction.
  extensions: readonly string[] = SYMBOL_TABLE_EXTENSIONS,
): Promise<CorpusSelection> {
  const selection: CorpusSelection = { kept: [], ingestIgnored: 0, codegraphExcluded: 0 };

  const walk = async (absolute: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(child);
        continue;
      }
      if (!extensions.some((ext) => extensionOf(entry.name) === ext)) continue;
      if (isDeclarationFile(entry.name)) continue;

      const relPath = relative(repoRoot, child).split(sep).join("/");
      if (exclude?.ingest.ignores(relPath) === true) {
        selection.ingestIgnored++;
      } else if (exclude?.codegraph.ignores(relPath) === true) {
        selection.codegraphExcluded++;
      } else {
        selection.kept.push(relPath);
      }
    }
  };

  await walk(dir);
  selection.kept.sort();
  return selection;
}

/** Walker output for one file, or `null` when the file could not be parsed. */
export function extractFile(
  repoRoot: string,
  relPath: RelPath,
  composer: DefaultSymbolIdComposer,
  factory: LanguageFactory,
): FileExtraction | null {
  const config = CODEGRAPH_LANGUAGES[extensionOf(relPath)];
  if (!config) return null;
  const { walker } = factory.create(config.language);
  if (!walker) return null;

  try {
    const code = readFileSync(join(repoRoot, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(config.loadParser());
    const nativeRoot = parser.parse(code).rootNode;
    // The production fast path (bd tea-rags-mcp-1v12o.2.4), mirrored here because
    // the tally measures THIS function: a harness that materialized what
    // production skips would report a wall production never pays.
    if (fileIsInertForExtraction(nativeRoot, walker.extractionBearingNodeTypes)) {
      return { relPath, language: config.language, imports: [], chunks: [], fileScope: [] };
    }
    const tree = { rootNode: materializeTree(nativeRoot, code) };
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
export function buildSymbolDefs(extraction: FileExtraction): SymbolDefinition[] {
  return extraction.chunks.map((chunk) => ({
    symbolId: chunk.symbolId,
    fqName: chunk.symbolId,
    shortName: lastSegment(chunk.symbolId),
    relPath: extraction.relPath,
    scope: chunk.scope,
  }));
}

interface RunCounters {
  /** Files whose call sites were diffed — `.ts` / `.tsx`. */
  files: number;
  /** Files walked into the symbol table only, never scored — `.js` / `.jsx` / `.mjs` / `.cjs`. */
  symbolTableOnlyFiles: number;
  /** Files `.gitignore` and friends drop — production has no index entry for them. */
  ingestIgnoredFiles: number;
  /** Files the codegraph layer drops — generated, test, or per-language non-app code. */
  codegraphExcludedFiles: number;
  parseFailures: number;
  callSites: number;
  dispatchSkipped: number;
  programUnavailable: number;
  nodeNotLocated: number;
  /** `nodeNotLocated` split by shape — the harness's own blind spot, itemised. */
  nodeNotLocatedByShape: OracleUnlocatedTally;
  checkerExternal: number;
  /** Of `checkerExternal`, the project's OWN generated output — the artifact probe. */
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
    symbolTableOnlyFiles: 0,
    ingestIgnoredFiles: 0,
    codegraphExcludedFiles: 0,
    parseFailures: 0,
    callSites: 0,
    dispatchSkipped: 0,
    programUnavailable: 0,
    nodeNotLocated: 0,
    nodeNotLocatedByShape: tallyUnlocatedShapes([]),
    checkerExternal: 0,
    checkerExternalNonSource: 0,
    checkerUnknown: 0,
  };

  // Pass 1 — symbol table plus the run-global class hierarchy the chain reads.
  // Both are populated from EVERY walkable language, as production's run state
  // does (`CodegraphRunState#classExtends` is run-global, not per-language);
  // pass 2 then narrows to the files this resolver actually owns.
  const selection = await collectSourceFiles(repoRoot, targetDir, await buildCorpusExclusionFilter(repoRoot, factory));
  counters.ingestIgnoredFiles = selection.ingestIgnored;
  counters.codegraphExcludedFiles = selection.codegraphExcluded;
  // An all-excluded corpus is a configuration answer, not a clean measurement,
  // and a report of "0 sites, no mismatches" would read as a perfect score. It
  // is a real configuration: the mastodon BENCH corpus ships a `.contextignore`
  // excluding `/app/javascript/` and every `*.ts` because it exists to
  // benchmark Ruby navigation, so production indexes no TypeScript there at all
  // (bd tea-rags-mcp-2mvc2).
  if (selection.kept.length === 0) {
    throw new Error(
      `No file under ${targetDir} survives the exclusions production applies ` +
        `(${selection.ingestIgnored} dropped by .gitignore and friends, ` +
        `${selection.codegraphExcluded} generated/test/non-app). ` +
        `Check the project's ignore files — this corpus carries no indexable source for this harness.`,
    );
  }
  const scored: FileExtraction[] = [];
  const classExtends: Record<string, string> = {};

  for (const relPath of selection.kept.slice(0, limit)) {
    const extraction = extractFile(repoRoot, relPath, composer, factory);
    if (extraction === null) {
      counters.parseFailures++;
      continue;
    }
    symbolTableRef.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    if (isScoredSource(relPath)) {
      scored.push(extraction);
      counters.files++;
    } else {
      counters.symbolTableOnlyFiles++;
    }
  }

  if (!quiet) {
    process.stderr.write(
      `pass 1: ${counters.files} scored files (+${counters.symbolTableOnlyFiles} symbol-table only), ` +
        `${symbolTableRef.size()} symbols\n`,
    );
  }

  // Pass 2 — both answers per call site.
  const rows: OracleRow[] = [];
  let done = 0;

  for (const extraction of scored) {
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
        if (handle !== null && !probe.located) {
          counters.nodeNotLocated++;
          if (probe.unlocatedShape !== undefined) counters.nodeNotLocatedByShape[probe.unlocatedShape]++;
        }
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
          chainOutput: chain === null ? "none" : chain.targetSymbolId === null ? "fileOnly" : "pinned",
          ...(chain !== null && { chain }),
          ...(probe.target !== undefined && { target: probe.target }),
          ...(handle !== null && probe.unlocatedShape !== undefined && { unlocatedShape: probe.unlocatedShape }),
        });
      }
    }

    done++;
    if (!quiet && done % 25 === 0) {
      process.stderr.write(`pass 2: ${done}/${scored.length} files, ${rows.length} call sites\n`);
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
export function buildCallContext(
  extraction: FileExtraction,
  chunk: FileExtraction["chunks"][number],
  classExtends: Record<string, string>,
  symbolTable: InMemoryGlobalSymbolTable = symbolTableRef,
): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: chunk.scope,
    callerSymbolId: chunk.symbolId,
    imports: extraction.imports,
    symbolTable,
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
  const chainOutput = tallyChainOutput(rows);
  const priorities = flagTrackBPriorities(byFeature);
  const uncovered = findUncoveredCategories(byFeature, TYPE_FEATURE_CATEGORIES);
  const decomposedByFeature = decomposeOracleMismatches(rows, (row) => row.categories);
  const [decomposedOverall] = decomposeOracleMismatches(rows, () => ["all call sites"]);

  const out: string[] = [
    "",
    `TS codegraph type-checker oracle — ${relative(options.repoRoot, options.target) || "."} @ ${options.repoRoot}`,
    `files ${counters.files} scored (+${counters.symbolTableOnlyFiles} javascript in the symbol table, ` +
      `parse failures ${counters.parseFailures}) · call sites ${counters.callSites} · scored ${rows.length}`,
    `excluded as production excludes them: ${counters.ingestIgnoredFiles} by .gitignore and friends · ` +
      `${counters.codegraphExcludedFiles} generated/test/non-app`,
    `skipped: dispatch ${counters.dispatchSkipped} · no program ${counters.programUnavailable} · node not located ${counters.nodeNotLocated}`,
    `  by shape: ${ORACLE_UNLOCATED_SHAPES.map((s) => `${s} ${counters.nodeNotLocatedByShape[s]}`).join(" · ")}`,
    `checker external ${counters.checkerExternal} (of which the project's own generated output ${counters.checkerExternalNonSource}) · unknown ${counters.checkerUnknown}`,
    `elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`,
    "",
    // Deliberately ahead of the verdict tables: this is what the chain SHIPPED,
    // and it is the only figure that moves when a change trades edges for
    // precision inside the checker's blind spots. Note `fileOnly` here counts
    // EDGES with a null symbol id — not the same quantity as the `fileOnly`
    // VERDICT below, which means "both sides agree on the file, differ on the
    // member".
    "CHAIN OUTPUT (what the resolver emitted, before any comparison)",
    `  edges ${chainOutput.edges} (of which file-only ${chainOutput.fileOnly}) · unresolved ${chainOutput.unresolved}`,
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
        `(interface-vs-impl ${wrongFile.interfaceVsImpl}, declaration-site path ${wrongFile.declarationSitePath}, ` +
        `inherited constructor ${wrongFile.inheritedConstructor})`,
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
      chainOutput,
      byFeature,
      byReceiver,
      priorities,
      uncovered,
      decomposedOverall,
      decomposedByFeature,
      decomposedByReceiver: decomposeOracleMismatches(rows, (row) => [row.receiverKind]),
      samples: {
        missed: sample("missed"),
        wrongFile: sample("wrongFile"),
        phantom: sample("phantom"),
        // The blind spot needs its own samples for the same reason the verdicts
        // do: the shape tally says which case to work on, a row says where to
        // read. Grouped by shape so a rare bucket is not crowded out.
        nodeNotLocated: Object.fromEntries(
          ORACLE_UNLOCATED_SHAPES.map((shape) => [
            shape,
            rows.filter((row) => row.unlocatedShape === shape).slice(0, options.samples),
          ]),
        ),
      },
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
