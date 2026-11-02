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
 * `src/lib.rs`, `lib.fixture` for a top-level `#[cfg(test)] fn fixture`.
 */
const RUST_INLINE_ITEM_VOCABULARY: ScopeChunkVocabulary = { ...TEST_SCOPE_CHUNK_VOCABULARY, idPath: "namespace" };

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
 */
function moduleAttributeLines(node: AstNode, code: string): TestScopeLine[] {
  const first = attributedStart(node);
  if (first.startPosition.row === node.startPosition.row) return [];
  const modRowStart = node.startIndex - node.startPosition.column;
  const startLine = attributeStartLine(node);
  return code
    .substring(first.startIndex, modRowStart)
    .trimEnd()
    .split("\n")
    .map((text, row) => ({ text, sourceLine: startLine + row }));
}

function buildRustScope(node: AstNode, code: string, pathPrefix = ""): TestScope {
  const localName = nodeName(node);
  const name = pathPrefix ? `${pathPrefix}.${localName}` : localName;
  const otherLines: TestScopeLine[] = moduleAttributeLines(node, code);
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
    startLine: attributeStartLine(node),
    endLine: node.endPosition.row + 1,
    setupLines: [],
    otherLines,
    examples,
    children,
  };
}

export function buildRustTestScope(containerNode: AstNode, code: string): TestScope {
  return buildRustScope(containerNode, code);
}

/** The subject every Rust test id hangs under: the file's basename without `.rs`. */
function rustFileSubject(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.rs$/, "") || "rust";
}

export function rustTestScopeChunks(
  containerNode: AstNode,
  code: string,
  filePath: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  return produceTestScopeChunks(buildRustTestScope(containerNode, code), rustFileSubject(filePath), config);
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

/** The chunk of one test-only item outside a test module (none when the kernel drops it as noise). */
export function rustInlineItemChunks(
  node: AstNode,
  itemSource: RustInlineItemSource,
  filePath: string,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  const subject = rustFileSubject(filePath);
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
              text: sourceText(containerNode, code),
              startLine: attributeStartLine(containerNode),
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
