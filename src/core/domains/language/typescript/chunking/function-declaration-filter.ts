/**
 * TypeScript declaration filter + chunk classifier for the MODULE-LEVEL
 * const-bound function expression (bd tea-rags-mcp-grz07):
 *
 *   export const genValidationSchema = (message: string) => message.trim();
 *
 * Mirrors the JavaScript provider's `jsAssignmentFilterHook` +
 * `JsChunkClassifier` pair, which has carried this exact shape for JavaScript
 * since bd tea-rags-mcp-kfzx. Two collaborators are needed because they answer
 * different questions at different moments in the chunker engine:
 *
 *   - the FILTER decides whether `findChunkableNodes` claims the declaration.
 *     It must, because listing `lexical_declaration` in `chunkableTypes`
 *     unconditionally would stop the walk at EVERY module-level `const` — and
 *     the const-object namespace (`export const X = { m() {} }`) depends on the
 *     walk descending THROUGH the declaration to reach its `method_definition`
 *     (bd tea-rags-mcp-62hzr). A filter verdict of `false` restores that
 *     descent, so the two shapes coexist in one declaration node type;
 *
 *   - the CLASSIFIER supplies the name. A `lexical_declaration` carries no
 *     `name` field and no direct `identifier` child (the identifier is nested
 *     inside the `variable_declarator`), so the engine's generic shaping would
 *     emit an anonymous `block` chunk with no symbolId.
 *
 * Both delegate to `infra/symbolid`'s shared gate — the same function the
 * codegraph walker calls — so the Qdrant payload `symbolId` and
 * `cg_symbols.symbol_id` cannot drift for the same physical AST node
 * (`.claude/rules/symbolid-convention.md`).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkDecision, ChunkingHook, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { moduleLevelFunctionDeclarationNames } from "../../../../infra/symbolid/index.js";

/** The declaration node types a `variable_declarator` can sit under. */
const DECLARATION_TYPES = new Set(["lexical_declaration", "variable_declaration"]);

/**
 * Keep a `const` / `let` / `var` declaration chunkable ONLY when it declares at
 * least one module-level function. Everything else abstains — `undefined`, not
 * `false`, so the verdict composes with the sibling filter hooks the engine
 * consults in order (first non-`undefined` wins).
 *
 * Returning `false` rather than abstaining for a non-function declaration is
 * what preserves the descent the const-object namespace needs: on `false` the
 * engine walks INTO the node's children instead of claiming it.
 */
export const typescriptFunctionDeclarationFilterHook: ChunkingHook = {
  name: "typescript-function-declaration-filter",

  filterNode(node: AstNode): boolean | undefined {
    if (!DECLARATION_TYPES.has(node.type)) return undefined;
    return moduleLevelFunctionDeclarationNames(node).length > 0;
  },

  process(): void {
    // No-op — this hook is filter-only. Writing `ctx.bodyChunks` here would
    // claim the container and short-circuit the rest of the chain
    // (`.claude/rules/chunker-hooks.md`).
  },
};

/**
 * Compose the chunk(s) for a declaration the filter kept.
 *
 * One `EmittedChunk` per qualifying declarator, so a comma list
 * (`const a = () => 1, b = () => 2`) yields a chunk per name rather than one
 * anonymous chunk for the statement. The symbolId is the bare name: a
 * module-level declaration has no enclosing scope to compose against, exactly
 * as for a top-level `function_declaration`.
 *
 * Every other chunkable node passes through to the engine's generic shaping —
 * classes, methods, interfaces and functions are all named correctly by it
 * already, and this classifier exists only for the shape that is not.
 */
export const typescriptChunkClassifier: LanguageChunkClassifier = {
  classifyNode(node: AstNode): ChunkDecision {
    if (!DECLARATION_TYPES.has(node.type)) return { kind: "passthrough" };
    const names = moduleLevelFunctionDeclarationNames(node);
    if (names.length === 0) return { kind: "passthrough" };
    return {
      kind: "emit",
      chunks: names.map((name) => ({ name, symbolId: name, chunkType: "function" as const })),
    };
  },
};
