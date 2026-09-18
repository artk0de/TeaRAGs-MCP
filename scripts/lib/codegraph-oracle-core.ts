/**
 * The language-neutral core every codegraph oracle scores with: the row and
 * verdict vocabulary, the diff that turns two answers into a verdict, and the
 * tally that aggregates rows under labels.
 *
 * It was born inside `scripts/ts-codegraph-typechecker-oracle.ts` and the
 * Python oracle (`py-oracle-core.ts`) imported it from there, so a library
 * depended on an entry-point script. It lives here now, and the TypeScript
 * script re-exports every name of it that it used to export, so its importers keep
 * their address (bd tea-rags-mcp-xuywm).
 *
 * Everything is a pure function over in-memory values: no compiler, no
 * filesystem, no corpus.
 */

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
 * Why the harness could not put a `CallRef` on a node the checker will answer
 * about — the taxonomy of its OWN blind spot (bd tea-rags-mcp-2mvc2). The
 * finders named below live in `scripts/ts-codegraph-typechecker-oracle.ts`,
 * which is the only harness that sets this field.
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
 *     via `findNewExpression`.
 *   - `superCall` — `super(...)`. A `CallExpression` whose callee is the
 *     `super` keyword rather than an identifier, so `callSiteAt` cannot index
 *     it; located via `findSuperCall`. The walker re-shapes it to
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
export function isOutsideProjectSource(relPath: string): boolean {
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
 * Every declaration-file suffix TypeScript recognises. `.d.ts` alone is not the
 * set: a package shipping ESM or CJS typings writes `.d.mts` / `.d.cts`, and
 * those do not END with `.d.ts` (bd tea-rags-mcp-2mvc2).
 */
export const DECLARATION_FILE_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"] as const;

/**
 * Compiled and generated outputs that are inside the repo root but are not
 * source. `toRelPath` accepts them because they are under the root, and a
 * declaration resolved into `build/` would then be scored against the `src/`
 * file the chain names — a `wrongFile` that is purely an artifact of the
 * worktree having been built. They are external for measurement purposes.
 */
export function isNonSourceTarget(relPath: string): boolean {
  return (
    relPath.startsWith("build/") ||
    relPath.startsWith("dist/") ||
    DECLARATION_FILE_SUFFIXES.some((suffix) => relPath.endsWith(suffix))
  );
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
