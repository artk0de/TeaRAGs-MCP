/**
 * Shared scaffolding for the Swift chunking-hook tests.
 *
 * Two entry points, one per test altitude:
 *   - `parseSwiftContainer` — a real tree-sitter-swift parse, materialized, so a
 *     hook can be driven directly against a `HookContext` (the altitude the
 *     TypeScript and Ruby chunking tests use).
 *   - `createSwiftChunkerWithHooks` — the whole engine with `swiftHooks` wired
 *     into the real `SwiftLanguage` chunker config. The wiring lives here (not
 *     in `swift/index.ts`) only until the parent session lands it; the spread
 *     keeps working unchanged once it does.
 */

import Parser from "tree-sitter";

import type { AstNode } from "../../../../../../../src/core/contracts/types/ast.js";
import type { HookContext } from "../../../../../../../src/core/contracts/types/chunker.js";
import type {
  LanguageFactoryDescriptor,
  LanguageProvider,
} from "../../../../../../../src/core/contracts/types/language.js";
import { createHookContext } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/types.js";
import { TreeSitterChunker } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer } from "../../../../../../../src/core/domains/language/index.js";
import { swiftHooks } from "../../../../../../../src/core/domains/language/swift/chunking/index.js";
import { SwiftLanguage } from "../../../../../../../src/core/domains/language/swift/index.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";
import type { CodeChunk } from "../../../../../../../src/core/types.js";

let cachedLanguage: unknown;

/** Load the grammar once per worker — `setLanguage` is cheap, `import` is not. */
async function swiftGrammar(): Promise<unknown> {
  if (!cachedLanguage) {
    const mod = (await import("tree-sitter-swift")) as { default?: unknown };
    cachedLanguage = mod.default ?? mod;
  }
  return cachedLanguage;
}

/** Parse `code` and materialize it, so `previousNamedSibling` / `parent` are populated. */
export async function parseSwift(code: string): Promise<AstNode> {
  const parser = new Parser();
  parser.setLanguage((await swiftGrammar()) as Parser.Language);
  return materializeTree(parser.parse(code).rootNode, code);
}

function search(root: AstNode, type: string): AstNode | null {
  if (root.type === type) return root;
  for (const child of root.children) {
    const hit = search(child, type);
    if (hit) return hit;
  }
  return null;
}

/** Depth-first search for the first node of `type` under `root`. */
export function findFirst(root: AstNode, type: string): AstNode {
  const hit = search(root, type);
  if (!hit) throw new Error(`No ${type} node found`);
  return hit;
}

/** Every member declaration of a container body, in source order. */
export function memberDeclarations(container: AstNode): AstNode[] {
  const body = container.namedChildren.find((c) => c.type.endsWith("_body"));
  if (!body) return [];
  return body.namedChildren.filter(
    (c) =>
      c.type === "function_declaration" || c.type === "init_declaration" || c.type === "protocol_function_declaration",
  );
}

/**
 * Build the `HookContext` the engine would hand a hook for the first container
 * in `code`, with every member declaration as a valid child.
 */
export async function parseSwiftContainer(
  code: string,
  filePath = "Sample.swift",
  containerType = "class_declaration",
): Promise<{ ctx: HookContext; container: AstNode; members: AstNode[] }> {
  const root = await parseSwift(code);
  const container = findFirst(root, containerType);
  const members = memberDeclarations(container);
  const ctx = createHookContext(container, members, code, { maxChunkSize: 1000 }, filePath);
  return { ctx, container, members };
}

/**
 * The real chunker, over a Swift provider whose chunker config carries
 * `swiftHooks`. Mirrors what `swiftChunkerHooks` looks like once the parent
 * session wires `hooks: swiftHooks` into it.
 */
export function createSwiftChunkerWithHooks(maxChunkSize = 1000): TreeSitterChunker {
  const base = new SwiftLanguage();
  const provider: LanguageProvider = {
    kernel: base.kernel,
    chunkerHooks: { ...base.chunkerHooks, hooks: swiftHooks },
  };
  const factory: LanguageFactoryDescriptor = {
    create: () => provider,
    supported: () => ["swift"],
    signalFloors: () => new Map(),
  };
  return new TreeSitterChunker(
    { chunkSize: 500, chunkOverlap: 50, maxChunkSize },
    new DefaultSymbolIdComposer(),
    factory,
  );
}

/** Chunk `code` as Swift through the hook-wired chunker. */
export async function chunkSwift(code: string, filePath = "Sample.swift", maxChunkSize = 1000): Promise<CodeChunk[]> {
  return createSwiftChunkerWithHooks(maxChunkSize).chunk(code, filePath, "swift");
}

/** The chunk carrying `symbolId`, or undefined. */
export function chunkFor(chunks: CodeChunk[], symbolId: string): CodeChunk | undefined {
  return chunks.find((c) => c.metadata.symbolId === symbolId);
}
