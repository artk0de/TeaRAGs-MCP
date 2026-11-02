/**
 * Test-Spec Scope Chunker — reads Vitest/Jest/Mocha-style test specs into the
 * neutral `TestScope` tree (`contracts/types/chunker.ts`) and hands it to the
 * kernel's `produceTestScopeChunks`, which emits one chunk per EXAMPLE
 * (bd tea-rags-mcp-b55x2, epic tea-rags-mcp-phftd). TypeScript AST:
 * call_expression + arrow_function/function_expression callbacks +
 * statement_block bodies.
 *
 * This file owns only the TypeScript reading — which calls are containers,
 * examples and hooks, what a scope or example is called, and the top-level
 * name. Chunk shape, symbolIds, `~N` and line ranges are the kernel's
 * (`.claude/rules/test-spec-chunking.md`).
 *
 * ── Language-list pointer (MANDATORY) ────────────────────────────────
 * This hook emits `chunkType: "test"` / `"test_setup"` for TypeScript.
 * The list of languages that support DSL test chunks is published in
 * three skill files that consumers read; when you ADD a new language
 * (or REMOVE one) you MUST update ALL of them in the same commit:
 *
 *   - plugins/dinopowers/skills/test-driven-development/SKILL.md
 *     (Iron Rule fallback paragraph — supported-languages list)
 *   - plugins/tea-rags/skills/tests-as-context/SKILL.md
 *     (Step 0 SKIP block — currently-supported parenthesis)
 *   - plugins/tea-rags/skills/filter-building/SKILL.md
 *     (chunkType section — supported-languages table)
 *
 * The canonical structure for a new language's hook lives in
 * `.claude/rules/test-spec-chunking.md`; that rule file also carries
 * the "update the 3 skills" checklist.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type {
  BodyChunkResult,
  ChunkDecision,
  ChunkingHook,
  HookChunkingConfig,
  HookContext,
  LanguageChunkClassifier,
  TestScope,
} from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks, TEST_SCOPE_CHUNK_VOCABULARY, type ScopeChunkVocabulary } from "../../kernel/index.js";
import { isInlineTestNode } from "../inline-tests.js";
import { getCallDisplayName, getCallName, isTestFile } from "./test-dsl-filter.js";

// ── Constants ────────────────────────────────────────────────────────

const CONTAINER_METHODS = new Set(["describe", "context", "suite"]);

const EXAMPLE_METHODS = new Set(["it", "test", "bench", "fit", "ftest", "xit", "xtest"]);

const SETUP_METHODS = new Set([
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
  "before",
  "after",
  "setup",
  "teardown",
]);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * If `node` is a statement that wraps a call_expression (typically
 * expression_statement), return the inner call_expression. Otherwise
 * return null.
 */
function unwrapStatementCall(node: AstNode): AstNode | null {
  if (node.type === "call_expression") return node;
  if (node.type === "expression_statement") {
    const inner = node.namedChildren.find((c) => c.type === "call_expression");
    return inner ?? null;
  }
  return null;
}

function isCallback(node: AstNode): boolean {
  return node.type === "arrow_function" || node.type === "function_expression";
}

/**
 * Find the callback body (statement_block) for a DSL call.
 * Returns null when the call has no arrow_function / function_expression
 * argument (e.g. `describe(User)` with no callback).
 */
function findCallbackBody(node: AstNode): AstNode | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (isCallback(arg)) {
      const body = arg.childForFieldName("body");
      if (body?.type === "statement_block") return body;
    }
  }
  return null;
}

/**
 * True when an example-named call is shaped like an example: its arguments
 * carry a string / template title or a callback — `it('x', fn)`,
 * `it.todo('x')`, `it(title, () => …)`, `it.each(t)('x', fn)`. A call with
 * neither — `test(app)`, a shared-behaviour helper that happens to be named
 * `test` — is an ordinary statement of its scope (bd tea-rags-mcp-c0vdv).
 */
function isExampleShaped(node: AstNode): boolean {
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const [title] = args;
  if (title?.type === "string" || title?.type === "template_string") return true;
  return args.some(isCallback);
}

/**
 * The display name of a scope or example: the call as written plus its first
 * argument — `describe 'User'`, `context "when admin"`, `it.skip 'pending'`,
 * `it.each 'adds %i'`. The argument is kept verbatim (quotes included) with
 * line breaks folded to one space, so the name is one line and still greps
 * back to the source. A call whose first argument is its callback is named by
 * the call alone.
 */
function extractScopeName(node: AstNode, code: string): string {
  const callName = getCallDisplayName(node, code) ?? "unknown";
  const firstArg = node.childForFieldName("arguments")?.namedChildren[0];
  if (!firstArg || isCallback(firstArg)) return callName;

  const argText = code.substring(firstArg.startIndex, firstArg.endIndex).replace(/\s*\n\s*/g, " ");
  return `${callName} ${argText}`;
}

/**
 * Extract the top-level symbol name from a describe(NAME, ...) call.
 * Identifier → its text. String/template literal → stripped of surrounding
 * quotes/backticks. Falls back to the scope's full name when no arg fits.
 */
export function extractTopLevelName(containerNode: AstNode, code: string): string {
  const args = containerNode.childForFieldName("arguments");
  if (args) {
    for (const arg of args.namedChildren) {
      if (arg.type === "identifier") {
        return code.substring(arg.startIndex, arg.endIndex);
      }
      if (arg.type === "string" || arg.type === "template_string") {
        const text = code.substring(arg.startIndex, arg.endIndex);
        return text.replace(/^['"`]|['"`]$/g, "");
      }
    }
  }
  return extractScopeName(containerNode, code);
}

/** True when `node` is a DSL container call (describe / context / suite). */
export function isDslContainerCall(node: AstNode, code: string): boolean {
  if (node.type !== "call_expression") return false;
  const name = getCallName(node, code);
  return name !== null && CONTAINER_METHODS.has(name);
}

// ── Core: buildScopeTree ─────────────────────────────────────────────

/**
 * Read a container call into the neutral scope tree. Setup is the scope's own
 * hooks only — the kernel inherits ancestors'. No TypeScript construct runs
 * examples defined elsewhere, so no line carries `delegatesExamples`: a
 * parametrized `it.each(table)(name, fn)` is ONE example here, not a
 * delegation.
 */
export function buildScopeTree(containerNode: AstNode, code: string): TestScope {
  const scope: TestScope = {
    name: extractScopeName(containerNode, code),
    startLine: containerNode.startPosition.row + 1,
    endLine: containerNode.endPosition.row + 1,
    setupLines: [],
    otherLines: [],
    examples: [],
    children: [],
  };

  const blockBody = findCallbackBody(containerNode);
  if (blockBody) readScopeBody(scope, blockBody, code);
  return scope;
}

/**
 * Fill `scope` from the statements of its body block: nested containers become
 * children, example-shaped calls examples, setup hooks setup lines, and every
 * other non-blank row of the block an `otherLines` entry.
 */
function readScopeBody(scope: TestScope, blockBody: AstNode, code: string): void {
  const codeLines = code.split("\n");
  const claimedRows = new Set<number>();
  const claim = (node: AstNode): string => {
    for (let { row } = node.startPosition; row <= node.endPosition.row; row++) claimedRows.add(row);
    return codeLines.slice(node.startPosition.row, node.endPosition.row + 1).join("\n");
  };

  for (const child of blockBody.namedChildren) {
    const call = unwrapStatementCall(child);
    if (!call) {
      // Non-call statement (lexical_declaration, return, etc.) — fall
      // through to otherLines collection below.
      continue;
    }

    const methodName = getCallName(call, code);
    if (!methodName) continue;

    if (CONTAINER_METHODS.has(methodName)) {
      scope.children.push(buildScopeTree(call, code));
      claim(child);
    } else if (EXAMPLE_METHODS.has(methodName) && isExampleShaped(call)) {
      scope.examples.push({
        name: extractScopeName(call, code),
        text: claim(child),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    } else if (SETUP_METHODS.has(methodName)) {
      scope.setupLines.push({ text: claim(child), sourceLine: child.startPosition.row + 1 });
    }
  }

  // Collect remaining non-blank lines in the body as otherLines.
  // statement_block in tree-sitter-typescript includes the surrounding `{`
  // and `}` rows. Ruby's body_statement excludes do/end; we mimic that by
  // skipping the boundary rows when the body spans multiple lines.
  const bodyStartRow = blockBody.startPosition.row;
  const bodyEndRow = blockBody.endPosition.row;
  const innerStart = bodyStartRow === bodyEndRow ? bodyStartRow : bodyStartRow + 1;
  const innerEnd = bodyStartRow === bodyEndRow ? bodyEndRow : bodyEndRow - 1;
  for (let row = innerStart; row <= innerEnd; row++) {
    if (claimedRows.has(row)) continue;
    const lineText = codeLines[row];
    if (lineText !== undefined && lineText.trim().length > 0) {
      scope.otherLines.push({ text: lineText, sourceLine: row + 1 });
    }
  }
}

// ── Core: Vitest in-source test blocks ───────────────────────────────

/** Root scope name of a Vitest in-source test block (`if (import.meta.vitest) { … }`). */
const INLINE_TEST_SCOPE_NAME = "vitest";

/**
 * The subject an in-source block's ids hang under: the file's basename without
 * its extension (`src/math.ts` → `math.vitest.it "adds"`), as Rust's inline
 * test module hangs under its file's name.
 */
function inlineTestSubjectName(filePath: string): string {
  const basename = filePath.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return basename.replace(/\.[^.]+$/, "") || INLINE_TEST_SCOPE_NAME;
}

/**
 * Read a Vitest in-source test block into the neutral scope tree. The `if`
 * block is the root scope: its `const { it, expect } = import.meta.vitest`
 * destructuring is an `otherLines` row (the scope's setup chunk), and its
 * `describe` / `it` / `test` calls are scopes and examples read exactly as a
 * container callback's body.
 */
export function buildInlineTestScopeTree(ifNode: AstNode, code: string): TestScope {
  const scope: TestScope = {
    name: INLINE_TEST_SCOPE_NAME,
    startLine: ifNode.startPosition.row + 1,
    endLine: ifNode.endPosition.row + 1,
    setupLines: [],
    otherLines: [],
    examples: [],
    children: [],
  };
  const blockBody = ifNode.childForFieldName("consequence");
  if (blockBody?.type === "statement_block") readScopeBody(scope, blockBody, code);
  return scope;
}

/**
 * An in-source block the default vocabulary yields no chunk for — calls the
 * DSL reader does not recognise (`import.meta.vitest.it(…)`), or own lines
 * under the noise floor — is still test code: read again without the floor,
 * its lines one `test` chunk under the `vitest` scope id, so the block never
 * falls through to a production chunk (bd tea-rags-mcp-52wk3.9).
 */
const IN_SOURCE_BLOCK_VOCABULARY: ScopeChunkVocabulary = {
  ...TEST_SCOPE_CHUNK_VOCABULARY,
  minSetupContent: 0,
  setupChunkType: "test",
};

/** The chunks of a Vitest in-source block; none only for a block with no line of its own. */
export function inlineTestBlockChunks(
  ifNode: AstNode,
  code: string,
  filePath: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  const scope = buildInlineTestScopeTree(ifNode, code);
  const subject = inlineTestSubjectName(filePath);
  const chunks = produceTestScopeChunks(scope, subject, config);
  return chunks.length > 0 ? chunks : produceTestScopeChunks(scope, subject, config, IN_SOURCE_BLOCK_VOCABULARY);
}

/**
 * Lifts a top-level Vitest in-source block past the engine's 50-character
 * noise gate, which would otherwise fold a tiny block into a production chunk
 * before `testScopeChunkerHook` sees it. The hook still claims the block; this
 * decision's chunk — the whole block, `test`, under the `vitest` scope id —
 * stands only where the hook yields nothing (a block with no line of its own).
 * A classifier is handed no source, so the recogniser reads the node's own
 * text at its file offsets.
 */
export const inlineTestBlockClassifier: LanguageChunkClassifier = {
  classifyNode(node: AstNode, filePath?: string): ChunkDecision {
    if (filePath === undefined || node.type !== "if_statement") return { kind: "passthrough" };
    if (!isInlineTestNode(node, " ".repeat(node.startIndex) + node.text)) return { kind: "passthrough" };
    const symbolId = `${inlineTestSubjectName(filePath)}${TEST_SCOPE_CHUNK_VOCABULARY.idSeparator}${INLINE_TEST_SCOPE_NAME}`;
    return { kind: "emit", chunks: [{ name: INLINE_TEST_SCOPE_NAME, symbolId, chunkType: "test" }] };
  },
};

// ── Core: produceScopeChunks ─────────────────────────────────────────

/** The chunks of one top-level container call: its scope tree, emitted by the kernel. */
export function produceScopeChunks(
  containerNode: AstNode,
  code: string,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  return produceTestScopeChunks(buildScopeTree(containerNode, code), extractTopLevelName(containerNode, code), config);
}

/** The chunks of a top-level DSL container call in a test file, or none for any other container. */
function produceDslContainerChunks(ctx: HookContext): BodyChunkResult[] {
  if (!isTestFile(ctx.filePath)) return [];
  if (!isDslContainerCall(ctx.containerNode, ctx.code)) return [];
  return produceScopeChunks(ctx.containerNode, ctx.code, ctx.config);
}

/**
 * A Vitest in-source block nested in a function body holding no DSL call the
 * engine extracts is emitted as a LEAF child of the function — no hook ever
 * sees it as a container — so it is labelled `test` here, under the id the
 * engine composes for it, instead of reaching the index as production code
 * (bd tea-rags-mcp-52wk3.9).
 */
function labelInlineTestChildren(ctx: HookContext): void {
  ctx.validChildren.forEach((child, index) => {
    if (isInlineTestNode(child, ctx.code)) ctx.methodChunkTypes.set(index, "test");
  });
}

// ── Hook export ──────────────────────────────────────────────────────

export const testScopeChunkerHook: ChunkingHook = {
  name: "test-scope-chunker",

  process(ctx: HookContext): void {
    const inlineTestBlock = isInlineTestNode(ctx.containerNode, ctx.code);
    if (!inlineTestBlock) labelInlineTestChildren(ctx);
    const chunks = inlineTestBlock
      ? inlineTestBlockChunks(ctx.containerNode, ctx.code, ctx.filePath, ctx.config)
      : produceDslContainerChunks(ctx);

    if (chunks.length > 0) {
      ctx.bodyChunks = chunks;
      ctx.skipChildren = true;
    }
  },
};
