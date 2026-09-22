/**
 * Quick/Nimble scope chunker — turns one `describe` / `context` tree into one
 * chunk per scenario, so `find_symbol` can address a single Quick scope and
 * search can rank one context over another. Without it a spec file is ONE
 * chunk: the whole `spec()` method.
 *
 * Emission rules, `symbolId` format and the own-lines-only line-range rule are
 * owned by `.claude/rules/test-spec-chunking.md`; this file is Swift's
 * adaptation of it and deliberately produces the same chunk shape as
 * `ruby/chunking/rspec-scope-chunker.ts` and
 * `typescript/chunking/test-scope-chunker.ts`.
 *
 * ── Language-list pointer (MANDATORY) ────────────────────────────────
 * This hook emits `chunkType: "test"` / `"test_setup"` for Swift Quick.
 * The list of languages that support DSL test chunks is published in
 * three skill files that consumers read; when you ADD a new language
 * (or REMOVE one) you MUST update ALL of them in the same commit:
 *
 *   - .claude-plugin/dinopowers/skills/test-driven-development/SKILL.md
 *     (Iron Rule fallback paragraph — supported-languages list)
 *   - .claude-plugin/tea-rags/skills/tests-as-context/SKILL.md
 *     (Step 0 SKIP block — currently-supported parenthesis)
 *   - .claude-plugin/tea-rags/skills/filter-building/SKILL.md
 *     (chunkType section — supported-languages table)
 *
 * ── What the hook claims, and why it is the TYPE ─────────────────────
 *
 * The scope tree is rooted at `spec()`, but the container this hook CLAIMS is
 * the `QuickSpec` subclass that declares it. That is not a preference — it is
 * the only context the engine offers in time. `processChildren` tests a child
 * for oversize BEFORE it tests whether the child is a container, so a `spec()`
 * longer than `maxChunkSize` (2500 by default; a 60-line spec clears it) is
 * character-split and never yields a hook context at all. Claiming at the type
 * keeps the behaviour size-independent: `chunkWithChildExtraction` builds the
 * type's context unconditionally, before any child is routed.
 *
 * The consequence is `ctx.skipChildren`, which suppresses EVERY member of the
 * suite, not just the one holding the DSL — the engine has no per-child drop
 * lever. So the claim also has to account for the rest of the type body, which
 * `suiteResidueChunk` does: one `test_setup` chunk carrying the header rows and
 * every member that is not a `spec()`, left un-symbolId'd so the engine names
 * it after the class exactly as `container-body-chunker.ts` would have. Nothing
 * in the file stops being searchable; what a Quick suite gives up is per-member
 * addressability for its static helpers, which Quick 7's `class func spec()`
 * shape makes rare.
 *
 * ── How this composes with `container-body-chunker.ts` ───────────────
 *
 * Both hooks write `ctx.bodyChunks` and the engine stops the chain at the first
 * writer, so ORDER is the whole contract: this hook runs first and abstains on
 * everything that is not a Quick suite with a `spec()` method, at which point
 * the body chunker claims exactly as it does today. An XCTest class, a
 * protocol, a production type — none of them reach a single line of scope-tree
 * work. When this hook does claim, the body chunker is skipped and the residue
 * chunk stands in for the type-level chunk it would have emitted.
 *
 * ── The Swift wrinkle: trailing closures ─────────────────────────────
 *
 * `describe("X") { … }` parses as `call_expression > call_suffix >
 * (value_arguments, lambda_literal)` — the closure is a SIBLING of the argument
 * list inside `call_suffix`, not an argument of the call, so TypeScript's "scan
 * the `arguments` field for an arrow_function" does not port. The body hangs off
 * the closure as a `statements` node which, like Ruby's `body_statement` and
 * unlike TS's `statement_block`, excludes the braces — except that it ends at
 * the INDENT column of the closing brace's row rather than before it, which is
 * why `otherLines` collection stops at `lastCoveredRow` and not at the node's
 * own end row.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { BodyChunkResult, ChunkingHook, ChunkType, HookContext } from "../../../../contracts/types/chunker.js";
import { toLineRanges } from "./container-body-chunker.js";
import {
  getSwiftCallName,
  isQuickSpecFile,
  QUICK_CONTAINER_METHODS,
  QUICK_EXAMPLE_METHODS,
  QUICK_SETUP_METHODS,
} from "./quick-dsl.js";
import { isQuickSuite, quickSpecMethods } from "./suite-recognition.js";

// ── Types ────────────────────────────────────────────────────────────

/** One setup / non-DSL statement, addressed by its 1-based FIRST source line. */
export interface QuickSetupLine {
  text: string;
  sourceLine: number;
}

/** One example call, with the 1-based line range it spans. */
export interface QuickItBlock {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * One node of the scope tree. Same field set as Ruby's `RSpecScope` and
 * TypeScript's `TestScope` — the canonical shape — with the Swift-specific
 * detail that the ROOT scope's `node` is a `function_declaration` (`spec()`)
 * while every descendant's is a `call_expression`.
 */
export interface QuickTestScope {
  name: string;
  node: AstNode;
  isLeaf: boolean;
  setupLines: QuickSetupLine[];
  ownItBlocks: QuickItBlock[];
  children: QuickTestScope[];
  otherLines: QuickSetupLine[];
}

/** Chunks shorter than this carry no searchable context — the engine's floor. */
const MIN_CHUNK_CONTENT_LENGTH = 50;

// ── AST helpers ──────────────────────────────────────────────────────

/** The `statements` list of a `function_body` or a `lambda_literal`, or null. */
function statementsOf(bodyNode: AstNode | null): AstNode | null {
  return bodyNode?.namedChildren.find((c) => c.type === "statements") ?? null;
}

/** The body statements of a `func` declaration. */
function methodStatements(methodNode: AstNode): AstNode | null {
  return statementsOf(methodNode.namedChildren.find((c) => c.type === "function_body") ?? null);
}

/**
 * The body statements of a DSL call's trailing closure. The closure is a child
 * of `call_suffix`, NOT an argument — `describe("X") { … }` has a
 * `value_arguments` sibling holding only the description string.
 */
function trailingClosureStatements(callNode: AstNode): AstNode | null {
  const suffix = callNode.namedChildren.find((c) => c.type === "call_suffix");
  return statementsOf(suffix?.namedChildren.find((c) => c.type === "lambda_literal") ?? null);
}

/** The first argument node of a call (`describe("X")` → the `"X"` argument). */
function firstArgument(callNode: AstNode): AstNode | null {
  const suffix = callNode.namedChildren.find((c) => c.type === "call_suffix");
  const args = suffix?.namedChildren.find((c) => c.type === "value_arguments");
  return args?.namedChildren[0] ?? null;
}

/** `describe "Invoice"` — the call name plus its first argument, verbatim. */
function scopeNameOf(callNode: AstNode, code: string): string {
  const callName = getSwiftCallName(callNode, code) ?? "unknown";
  const arg = firstArgument(callNode);
  return arg ? `${callName} ${code.substring(arg.startIndex, arg.endIndex)}` : callName;
}

/**
 * The symbol a scope tree hangs off: the first argument of its root `describe`,
 * stripped of quotes. `describe(Invoice.self)` and other non-literal arguments
 * are used verbatim; a describe with no argument falls back to the scope name.
 */
function topLevelNameOf(scope: QuickTestScope, code: string): string {
  const arg = firstArgument(scope.node);
  if (!arg) return scope.name;
  return code.substring(arg.startIndex, arg.endIndex).replace(/^["']|["']$/g, "");
}

/**
 * The last row carrying any of `node`'s text.
 *
 * A `statements` node ends just short of its closing brace — at the INDENT
 * column of that row, not at column 0 — so its end row is the brace's row and
 * reading `endPosition.row` verbatim would pull a stray `}` into `otherLines`.
 * Checking whether anything but whitespace precedes the end column answers it
 * for both that shape and a node that ends at a line break.
 */
function lastCoveredRow(node: AstNode, codeLines: string[]): number {
  const { row, column } = node.endPosition;
  const tail = codeLines[row]?.slice(0, column) ?? "";
  return tail.trim().length === 0 ? row - 1 : row;
}

/** Mark every row a node covers as claimed. */
function claimRows(node: AstNode, claimed: Set<number>): void {
  for (let { row } = node.startPosition; row <= node.endPosition.row; row++) claimed.add(row);
}

// ── Core: buildQuickScopeTree ────────────────────────────────────────

function emptyScope(name: string, node: AstNode): QuickTestScope {
  return { name, node, isLeaf: true, setupLines: [], ownItBlocks: [], children: [], otherLines: [] };
}

/**
 * Fill `scope` from the statements of its body: nested containers recurse,
 * examples and setup are collected verbatim, and every remaining non-blank row
 * inside the body becomes an `otherLine`.
 */
function populateScope(scope: QuickTestScope, statements: AstNode | null, code: string): void {
  if (!statements) return;
  const codeLines = code.split("\n");
  const claimed = new Set<number>();

  for (const child of statements.namedChildren) {
    if (child.type !== "call_expression") continue;
    const callName = getSwiftCallName(child, code);
    if (!callName) continue;

    const text = codeLines.slice(child.startPosition.row, child.endPosition.row + 1).join("\n");

    if (QUICK_CONTAINER_METHODS.has(callName)) {
      scope.children.push(buildContainerScope(child, code));
      scope.isLeaf = false;
      claimRows(child, claimed);
    } else if (QUICK_EXAMPLE_METHODS.has(callName)) {
      scope.ownItBlocks.push({
        text,
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
      claimRows(child, claimed);
    } else if (QUICK_SETUP_METHODS.has(callName)) {
      scope.setupLines.push({ text, sourceLine: child.startPosition.row + 1 });
      claimRows(child, claimed);
    }
  }

  const bodyEndRow = lastCoveredRow(statements, codeLines);
  for (let { row } = statements.startPosition; row <= bodyEndRow; row++) {
    if (claimed.has(row)) continue;
    const lineText = codeLines[row];
    if (lineText !== undefined && lineText.trim().length > 0) {
      scope.otherLines.push({ text: lineText, sourceLine: row + 1 });
    }
  }
}

function buildContainerScope(callNode: AstNode, code: string): QuickTestScope {
  const scope = emptyScope(scopeNameOf(callNode, code), callNode);
  populateScope(scope, trailingClosureStatements(callNode), code);
  return scope;
}

/**
 * The scope tree of one Quick `spec()` method. The root carries the method's
 * own name, so an example declared straight in `spec()` composes
 * `InvoiceSpec.spec` — the same id the engine would compose for the method.
 */
export function buildQuickScopeTree(methodNode: AstNode, code: string): QuickTestScope {
  const name = methodNode.childForFieldName("name")?.text ?? "spec";
  const scope = emptyScope(name, methodNode);
  populateScope(scope, methodStatements(methodNode), code);
  return scope;
}

// ── Core: produceQuickScopeChunks ────────────────────────────────────

/** The 1-based range a scope's OWN lines cover — never an ancestor's. */
function ownLineRange(scope: QuickTestScope): { startLine: number; endLine: number } {
  const lines = [
    ...scope.setupLines.map((s) => s.sourceLine),
    ...scope.otherLines.map((o) => o.sourceLine),
    ...scope.ownItBlocks.flatMap((b) => [b.startLine, b.endLine]),
  ];
  if (lines.length === 0) {
    return { startLine: scope.node.startPosition.row + 1, endLine: scope.node.endPosition.row + 1 };
  }
  return { startLine: Math.min(...lines), endLine: Math.max(...lines) };
}

function scopeChunk(
  scope: QuickTestScope,
  topLevelName: string,
  chunkType: ChunkType,
  contentParts: string[],
): BodyChunkResult | null {
  const content = contentParts.join("\n").trim();
  if (content.length < MIN_CHUNK_CONTENT_LENGTH) return null;
  return {
    content,
    ...ownLineRange(scope),
    chunkType,
    symbolId: `${topLevelName}.${scope.name}`,
    name: scope.name,
    parentSymbolId: topLevelName,
  };
}

/**
 * One chunk per example, each carrying the shared setup — the oversized-leaf
 * split. Every part keeps the leaf's `symbolId`; only the line range narrows.
 */
function splitOversizedLeaf(scope: QuickTestScope, topLevelName: string, sharedParts: string[]): BodyChunkResult[] {
  const sharedSetup = sharedParts.join("\n").trim();
  const results: BodyChunkResult[] = [];
  for (const itBlock of scope.ownItBlocks) {
    const content = (sharedSetup ? `${sharedSetup}\n${itBlock.text}` : itBlock.text).trim();
    if (content.length < MIN_CHUNK_CONTENT_LENGTH) continue;
    results.push({
      content,
      startLine: itBlock.startLine,
      endLine: itBlock.endLine,
      chunkType: "test",
      symbolId: `${topLevelName}.${scope.name}`,
      name: scope.name,
      parentSymbolId: topLevelName,
    });
  }
  return results;
}

function setupTexts(scopes: QuickTestScope[]): string[] {
  return scopes.flatMap((scope) => scope.setupLines.map((s) => s.text));
}

/**
 * Walk one scope tree, emitting per the canonical table: a leaf with examples
 * is a `test` chunk carrying ancestor setup, a leaf without them is
 * `test_setup`, an intermediate scope with its own examples gets one extra
 * `test_setup` chunk, and an empty scope emits nothing.
 */
function walkScope(
  scope: QuickTestScope,
  ancestors: QuickTestScope[],
  topLevelName: string,
  config: { maxChunkSize: number },
  results: BodyChunkResult[],
): void {
  const ownSetup = scope.setupLines.map((s) => s.text);
  const otherParts = scope.otherLines.map((o) => o.text);
  const itParts = scope.ownItBlocks.map((b) => b.text);

  if (!scope.isLeaf) {
    for (const child of scope.children) {
      walkScope(child, [...ancestors, scope], topLevelName, config, results);
    }
    if (itParts.length > 0) {
      const chunk = scopeChunk(scope, topLevelName, "test_setup", [...ownSetup, ...otherParts, ...itParts]);
      if (chunk) results.push(chunk);
    }
    return;
  }

  if (itParts.length === 0) {
    if (ownSetup.length === 0 && otherParts.length === 0) return;
    const chunk = scopeChunk(scope, topLevelName, "test_setup", [...ownSetup, ...otherParts]);
    if (chunk) results.push(chunk);
    return;
  }

  // A leaf's examples read as self-contained only with the setup every ancestor
  // scope contributes, so that setup is spliced into the CONTENT — while
  // `ownLineRange` keeps the range on this scope's own lines.
  const setupParts = [...setupTexts(ancestors), ...ownSetup];
  const content = [...setupParts, ...otherParts, ...itParts].join("\n").trim();
  if (content.length < MIN_CHUNK_CONTENT_LENGTH) return;

  if (content.length > config.maxChunkSize && scope.ownItBlocks.length > 1) {
    results.push(...splitOversizedLeaf(scope, topLevelName, [...setupParts, ...otherParts]));
    return;
  }

  const chunk = scopeChunk(scope, topLevelName, "test", [...setupParts, ...otherParts, ...itParts]);
  if (chunk) results.push(chunk);
}

/**
 * Every chunk one `spec()` method produces.
 *
 * Each top-level `describe` roots its own `symbolId` namespace, taken from its
 * description (`describe("Invoice")` → `Invoice.context "when overdue"`), which
 * is what keeps Swift's ids interchangeable with Ruby's and TypeScript's. Only
 * examples declared directly in `spec()` — outside any describe — fall back to
 * the suite type's own name, composing `InvoiceSpec.spec`.
 */
export function produceQuickScopeChunks(
  rootScope: QuickTestScope,
  suiteName: string,
  code: string,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  const results: BodyChunkResult[] = [];

  for (const child of rootScope.children) {
    walkScope(child, [rootScope], topLevelNameOf(child, code), config, results);
  }

  if (rootScope.ownItBlocks.length > 0) {
    const chunk = scopeChunk(rootScope, suiteName, rootScope.isLeaf ? "test" : "test_setup", [
      ...rootScope.setupLines.map((s) => s.text),
      ...rootScope.otherLines.map((o) => o.text),
      ...rootScope.ownItBlocks.map((b) => b.text),
    ]);
    if (chunk) results.push(chunk);
  }

  return results;
}

// ── The type body the claim would otherwise swallow ──────────────────

/**
 * Everything in the suite's body that is NOT a `spec()` method, as one
 * `test_setup` chunk — stored fixtures, static helpers, nested types.
 *
 * Deliberately not `extractSwiftContainerBody`: that one is a faithful port of
 * the engine's narrow parent chunk and stops at the first extracted member,
 * which is correct when the members are emitted separately and wrong here,
 * where `skipChildren` means they are not. No `symbolId` is set, so the engine
 * names this chunk after the class exactly as it names the body chunker's.
 */
function suiteResidueChunk(ctx: HookContext, specMethods: AstNode[]): BodyChunkResult | null {
  const body = ctx.containerNode.childForFieldName("body");
  if (!body) return null;

  const claimed = new Set<number>();
  for (const method of specMethods) claimRows(method, claimed);

  const rows: number[] = [];
  for (let row = body.startPosition.row + 1; row <= lastCoveredRow(body, ctx.codeLines) - 1; row++) {
    if (claimed.has(row)) continue;
    if (ctx.codeLines[row]?.trim().length) rows.push(row);
  }

  const content = rows
    .map((row) => ctx.codeLines[row])
    .join("\n")
    .trimEnd();
  if (content.length < MIN_CHUNK_CONTENT_LENGTH) return null;

  return {
    content,
    startLine: rows[0] + 1,
    endLine: rows[rows.length - 1] + 1,
    chunkType: "test_setup",
    lineRanges: toLineRanges(rows),
  };
}

// ── Hook export ──────────────────────────────────────────────────────

/**
 * Scope chunker (chain position 4) — after every filter and metadata hook,
 * BEFORE the generic body chunker, per `.claude/rules/test-spec-chunking.md`.
 * Claims the suite by writing `ctx.bodyChunks`, and sets `skipChildren` so the
 * engine does not also emit the `spec()` method it just flattened.
 */
export const swiftQuickScopeChunkerHook: ChunkingHook = {
  name: "swiftQuickScopeChunker",

  process(ctx: HookContext): void {
    if (!isQuickSpecFile(ctx.filePath)) return;
    if (!isQuickSuite(ctx.containerNode)) return;

    const specMethods = quickSpecMethods(ctx.containerNode);
    if (specMethods.length === 0) return;

    const suiteName = ctx.containerNode.childForFieldName("name")?.text ?? "";
    const scopeChunks = specMethods.flatMap((method) =>
      produceQuickScopeChunks(buildQuickScopeTree(method, ctx.code), suiteName, ctx.code, ctx.config),
    );
    if (scopeChunks.length === 0) return;

    const residue = suiteResidueChunk(ctx, specMethods);
    ctx.bodyChunks = residue ? [residue, ...scopeChunks] : scopeChunks;
    ctx.skipChildren = true;
  },
};
