/**
 * Rust attribute-based test scope chunking.
 *
 * Rust has no test DSL call to read. Test-only code is recognised from the
 * attribute AST (`isInlineTestNode`): a test-only module (`#[cfg(test)] mod`,
 * `#![cfg(test)]` body) is the scope root, a test-family function
 * (`#[test]`, `#[tokio::test]`, `#[rstest]`, …) is an example, and the
 * remaining direct items in the test module are setup/context. A test-only
 * item outside a test module is one chunk of its own: `test` for a test-family
 * function, `test_setup` for anything else. The neutral kernel still owns chunk
 * shape, ids, packing and line ranges.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type {
  BodyChunkResult,
  ChunkingHook,
  HookChunkingConfig,
  HookContext,
  TestExample,
  TestScope,
  TestScopeLine,
} from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks, TEST_SCOPE_CHUNK_VOCABULARY, type ScopeChunkVocabulary } from "../../kernel/index.js";
import { isInInlineTestOnlyFile, isInlineTestNode, isRustTestFunctionNode } from "../inline-tests.js";
import { rustKernel } from "../kernel.js";

/**
 * The item compiles only in the test build: it is test-only itself
 * (`isInlineTestNode`), or its file opens with an inner `#![cfg(test)]`. Every
 * item of such a file is chunked as a test-only item outside a test module — a
 * `mod` as a test scope, anything else as one `test` / `test_setup` chunk.
 */
export function isRustTestOnlyItem(node: AstNode, code: string): boolean {
  return isInlineTestNode(node, code) || isInInlineTestOnlyFile(node, code);
}

/**
 * Ids of a test-only item outside a test module hang under the file subject
 * as its full path: `lib.smoke` for a top-level `#[test] fn smoke` in
 * `src/lib.rs`, `lib.fixture` for a top-level `#[cfg(test)] fn fixture`. No
 * noise floor: the item is test code however short, and no other chunk would
 * carry it — dropped, it would land in a production chunk (bd
 * tea-rags-mcp-52wk3.9).
 */
const RUST_INLINE_ITEM_VOCABULARY: ScopeChunkVocabulary = {
  ...TEST_SCOPE_CHUNK_VOCABULARY,
  idPath: "namespace",
  minSetupContent: 0,
};

/**
 * A claimed test module the default vocabulary yields no chunk for (its own
 * lines under the noise floor, no test function) is still test code: read
 * again without the floor, so its rows reach a `test_setup` chunk instead of a
 * production one (bd tea-rags-mcp-52wk3.9).
 */
const CLAIMED_TEST_MODULE_VOCABULARY: ScopeChunkVocabulary = { ...TEST_SCOPE_CHUNK_VOCABULARY, minSetupContent: 0 };

/** One item's source as a chunk carries it: rows, and the text of those rows. */
export interface RustInlineItemSource {
  text: string;
  startLine: number;
  endLine: number;
}

/** An item's name; an `impl` block is named by its type without generics (`Worker<'s>` → `Worker`). */
function nodeName(node: AstNode): string {
  const identifier = node.childForFieldName("name") ?? node.namedChildren.find((child) => child.type === "identifier");
  if (identifier) return identifier.text;
  const implementedType = node.type === "impl_item" ? node.childForFieldName("type") : null;
  if (implementedType) return implementedType.text.split("<", 1)[0].trim();
  return node.type;
}

/**
 * The first of the outer attributes directly preceding `node`, else the node.
 * Tree-sitter keeps `attribute_item` as a sibling of its item, so the item's
 * own range starts after them; a comment between them ends the run.
 */
function attributedStart(node: AstNode): AstNode {
  let first = node;
  for (let sibling = node.previousNamedSibling; sibling?.type === "attribute_item"; ) {
    first = sibling;
    sibling = sibling.previousNamedSibling;
  }
  return first;
}

/** An outer doc comment (`///` or a `/**` block): tree-sitter-rust gives it an `outer_doc_comment_marker` child. */
function isOuterDocComment(node: AstNode): boolean {
  return (
    (node.type === "line_comment" || node.type === "block_comment") &&
    node.namedChildren.some((child) => child.type === "outer_doc_comment_marker")
  );
}

/** A comment's last row of text; a `///` line comment's range ends on the next row, column 0. */
function lastTextRow(node: AstNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

/**
 * Where a TEST-ONLY item's source starts: its outer attributes and the outer
 * doc comments directly above them (no blank row), interleaved in any order.
 * Plain `//` and inner `//!` comments end the run. Only claimed test-only
 * items read this — a production item keeps `attributedStart` — so the doc
 * rows of test code leave the production module remainder with their item.
 */
function testItemStart(node: AstNode): AstNode {
  let first = node;
  for (let sibling = node.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
    const joins =
      sibling.type === "attribute_item" ||
      (isOuterDocComment(sibling) && lastTextRow(sibling) + 1 >= first.startPosition.row);
    if (!joins) break;
    first = sibling;
  }
  return first;
}

/**
 * The sibling a classified test-only item's chunk opens at
 * (`ChunkDecision.leadingNode`) when an outer doc comment sits in the run
 * above it, else `undefined` — the engine's own attribute prefix then applies,
 * exactly as before.
 */
export function rustTestItemLeadingNode(node: AstNode): AstNode | undefined {
  const first = testItemStart(node);
  return first === attributedStart(node) ? undefined : first;
}

function attributeStartLine(node: AstNode): number {
  return attributedStart(node).startPosition.row + 1;
}

/** The item's source from its first outer attribute — never the rest of a row it shares. */
function sourceText(node: AstNode, code: string): string {
  return code.substring(attributedStart(node).startIndex, node.endIndex).trim();
}

function sourceLine(node: AstNode, code: string): TestScopeLine {
  return {
    text: sourceText(node, code),
    sourceLine: attributeStartLine(node),
  };
}

function exampleOf(node: AstNode, code: string): TestExample {
  const startLine = attributeStartLine(node);
  return {
    name: nodeName(node),
    text: sourceText(node, code),
    startLine,
    endLine: node.endPosition.row + 1,
  };
}

function directDeclarations(node: AstNode): AstNode[] {
  const body = node.childForFieldName("body");
  if (body) return [...body.namedChildren];
  const declarationList = node.namedChildren.find((child) => child.type === "declaration_list");
  return declarationList ? [...declarationList.namedChildren] : [];
}

/**
 * The outer attribute rows above a module's `mod` row — `#[cfg(test)]`,
 * `#[allow(dead_code)]` — as setup lines of its scope, one per row, else none.
 * Tree-sitter keeps them as siblings before the `mod_item`, so without this no
 * chunk claims them and the module remainder carries them as production code.
 * An attribute sharing the `mod` row is already inside the scope's rows.
 * `first` is where the leading run starts: the first attribute, or for the
 * claimed root the first outer doc comment (`testItemStart`).
 */
function moduleAttributeLines(node: AstNode, first: AstNode, code: string): TestScopeLine[] {
  if (first.startPosition.row === node.startPosition.row) return [];
  const modRowStart = node.startIndex - node.startPosition.column;
  const startLine = first.startPosition.row + 1;
  return code
    .substring(first.startIndex, modRowStart)
    .trimEnd()
    .split("\n")
    .map((text, row) => ({ text, sourceLine: startLine + row }));
}

/**
 * A nested module's doc comment is a statement of its parent test scope
 * already, so only the claimed root takes its doc comments
 * (`leadingStart = testItemStart`).
 */
function buildRustScope(
  node: AstNode,
  code: string,
  pathPrefix = "",
  leadingStart: AstNode = attributedStart(node),
): TestScope {
  const localName = nodeName(node);
  const name = pathPrefix ? `${pathPrefix}.${localName}` : localName;
  const otherLines: TestScopeLine[] = moduleAttributeLines(node, leadingStart, code);
  const examples: TestExample[] = [];
  const children: TestScope[] = [];

  for (const child of directDeclarations(node)) {
    if (child.type === "attribute_item" || child.type === "inner_attribute_item") continue;

    if (child.type === "mod_item") {
      children.push(buildRustScope(child, code, name));
      continue;
    }

    if (child.type === "function_item") {
      if (isRustTestFunctionNode(child, code)) examples.push(exampleOf(child, code));
      else otherLines.push(sourceLine(child, code));
      continue;
    }

    // Constants, helper declarations and non-test statements are setup/context
    // owned by this scope. Attribute siblings are folded into their item above.
    otherLines.push(sourceLine(child, code));
  }

  return {
    name,
    startLine: leadingStart.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    setupLines: [],
    otherLines,
    examples,
    children,
  };
}

export function buildRustTestScope(containerNode: AstNode, code: string): TestScope {
  return buildRustScope(containerNode, code, "", testItemStart(containerNode));
}

/** The subject a top-level Rust test id hangs under: the file's basename without `.rs`. */
function rustFileSubject(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.rs$/, "") || "rust";
}

/**
 * The path of the scope containers enclosing `node`, composed as the engine
 * composes a module's leaves — the kernel's `scopeContainerTypes`, joined
 * with its `scopeSeparator` (`inner`, `outer::deep`) — or `undefined` at file
 * top level. A claimed test item inside a module hangs under it, so its id
 * agrees with the engine's ids for the same module's relabelled test leaves
 * (`inner.Engine` beside `inner.accelerates_from_idle`).
 */
function enclosingScopePath(node: AstNode): string | undefined {
  const scopeTypes = rustKernel.scopeContainerTypes ?? [];
  const names: string[] = [];
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (scopeTypes.includes(ancestor.type)) names.unshift(nodeName(ancestor));
  }
  return names.length > 0 ? names.join(rustKernel.scopeSeparator ?? ".") : undefined;
}

/** The subject a claimed test item's ids hang under: its enclosing module path, else the file subject. */
function rustTestIdSubject(node: AstNode, filePath: string): string {
  return enclosingScopePath(node) ?? rustFileSubject(filePath);
}

export function rustTestScopeChunks(
  containerNode: AstNode,
  code: string,
  filePath: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  const scope = buildRustTestScope(containerNode, code);
  const subject = rustTestIdSubject(containerNode, filePath);
  const chunks = produceTestScopeChunks(scope, subject, config);
  return chunks.length > 0 ? chunks : produceTestScopeChunks(scope, subject, config, CLAIMED_TEST_MODULE_VOCABULARY);
}

/**
 * A single-scope root for a test-only item outside a test module: the file
 * subject is the root, a test-family function its one example, and any other
 * item one child scope whose rows are its setup.
 */
export function buildRustInlineItemScope(node: AstNode, subject: string, itemSource: RustInlineItemSource): TestScope {
  const root: TestScope = {
    name: subject,
    startLine: itemSource.startLine,
    endLine: itemSource.endLine,
    setupLines: [],
    otherLines: [],
    examples: [],
    children: [],
  };
  const name = nodeName(node);
  if (isRustTestFunctionNode(node, itemSource.text)) {
    root.examples.push({ name, text: itemSource.text, startLine: itemSource.startLine, endLine: itemSource.endLine });
    return root;
  }
  root.children.push({
    name,
    startLine: itemSource.startLine,
    endLine: itemSource.endLine,
    setupLines: [],
    otherLines: itemSource.text.split("\n").map((text, row) => ({ text, sourceLine: itemSource.startLine + row })),
    examples: [],
    children: [],
  });
  return root;
}

/** The chunk of one test-only item outside a test module. */
export function rustInlineItemChunks(
  node: AstNode,
  itemSource: RustInlineItemSource,
  filePath: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  const subject = rustTestIdSubject(node, filePath);
  return produceTestScopeChunks(
    buildRustInlineItemScope(node, subject, itemSource),
    subject,
    config,
    RUST_INLINE_ITEM_VOCABULARY,
  );
}

/**
 * A container that is not test-only keeps generic chunking; only its test-only
 * leaf members are relabelled — `test` for a test-family function, `test_setup`
 * for any other test-only item.
 */
function labelInlineTestMembers(ctx: HookContext): void {
  ctx.validChildren.forEach((child, index) => {
    if (isRustTestFunctionNode(child, ctx.code)) ctx.methodChunkTypes.set(index, "test");
    else if (isInlineTestNode(child, ctx.code)) ctx.methodChunkTypes.set(index, "test_setup");
  });
}

export const rustTestScopeChunkerHook: ChunkingHook = {
  name: "rust-test-scope-chunker",

  process(ctx: HookContext): void {
    const { containerNode, code } = ctx;
    if (!isRustTestOnlyItem(containerNode, code)) {
      labelInlineTestMembers(ctx);
      return;
    }

    const chunks =
      containerNode.type === "mod_item"
        ? rustTestScopeChunks(containerNode, code, ctx.filePath, ctx.config)
        : rustInlineItemChunks(
            containerNode,
            {
              text: code.substring(testItemStart(containerNode).startIndex, containerNode.endIndex).trim(),
              startLine: testItemStart(containerNode).startPosition.row + 1,
              endLine: containerNode.endPosition.row + 1,
            },
            ctx.filePath,
            ctx.config,
          );
    if (chunks.length === 0) return;
    ctx.bodyChunks = chunks;
    ctx.skipChildren = true;
  },
};

export function rustTestSourceText(node: AstNode, code: string): string {
  return sourceText(node, code);
}
