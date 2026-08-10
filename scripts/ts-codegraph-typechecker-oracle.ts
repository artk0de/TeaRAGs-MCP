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

import type { CallContext, CallRef, RelPath, SymbolDefinition } from "../src/core/contracts/types/codegraph.js";
import { collectSymbols, DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import { loadTsConfig, TSCallResolver } from "../src/core/domains/language/typescript/index.js";
import {
  composeSymbolId,
  findCallExpression,
} from "../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import type { TSProgramCache, TSProgramHandle } from "../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { classifyReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { lastSegment } from "../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import type { FileExtraction } from "../src/core/contracts/types/codegraph.js";
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
 * what makes a chain answer on the same call a fabricated one.
 */
export type OracleOutcome =
  | { kind: "inProject"; answer: OracleAnswer }
  | { kind: "external" }
  | { kind: "unknown" };

/**
 * How the two answers relate.
 *
 * Against IN-PROJECT ground truth: `match` / `fileOnly` are agreement at symbol
 * / file granularity; `wrongFile` and `missed` are the mismatch kinds.
 *
 * Against EXTERNAL ground truth: `agreeExternal` is correct silence, `phantom`
 * is the chain inventing an in-project target for a call that provably leaves
 * the project — a precision defect strictly worse than declining, and invisible
 * unless external is tracked separately.
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

/** One scored call site. */
export interface OracleRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiverKind: string;
  categories: string[];
  verdict: OracleVerdict;
  /** What each side answered, carried so mismatch samples are actionable. */
  chainTarget?: string;
  oracleTarget?: string;
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
 * Classify one call site by comparing the two answers.
 *
 * Symbol-level disagreement degrades to `fileOnly` rather than `wrongFile`: the
 * emitted edge still lands on the right file, and the contract explicitly
 * allows a null `targetSymbolId` for "the file is certain, the member is not".
 * Counting that as a mismatch would drown the real precision bugs.
 */
export function diffResolution(chain: OracleAnswer | null, oracle: OracleOutcome): OracleVerdict {
  if (oracle.kind === "unknown") return chain === null ? "bothUnresolved" : "chainOnly";
  if (oracle.kind === "external") return chain === null ? "agreeExternal" : "phantom";
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

const TABLE_COLUMNS = ["sites", "oracle", "match", "fileOnly", "wrongFile", "missed", "mismatch%", "ext", "phantom", "phantom%"] as const;

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

  const targetRelPath = cache.toRelPath(declaration.getSourceFile().fileName);
  if (targetRelPath === null || isNonSourceTarget(targetRelPath)) {
    return { outcome: { kind: "external" }, located: true, nonSource: targetRelPath !== null, categories };
  }

  return {
    outcome: {
      kind: "inProject",
      answer: { targetRelPath, targetSymbolId: pinOracleSymbol(declaration, targetRelPath, symbolTableRef) },
    },
    located: true,
    nonSource: false,
    categories,
  };
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
function pinOracleSymbol(declaration: ts.Declaration, targetRelPath: string, table: InMemoryGlobalSymbolTable): string | null {
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
function isGenericCall(node: ts.CallExpression, signature: ts.Signature | undefined, declaration: ts.Declaration | undefined): boolean {
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
    throw new Error("TSCallResolver built no program cache — unset CODEGRAPH_TS_TYPECHECKER to enable the type checker.");
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
          ...(chain !== null && { chainTarget: `${chain.targetRelPath}::${chain.targetSymbolId ?? "?"}` }),
          ...(probe.outcome.kind === "inProject" && {
            oracleTarget: `${probe.outcome.answer.targetRelPath}::${probe.outcome.answer.targetSymbolId ?? "?"}`,
          }),
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
      out.push(`  ${tally.label}: ${tally.phantom} phantom of ${tally.external} external (${(tally.phantomRate * 100).toFixed(1)}%)`);
    }
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
