/**
 * Accessor macros declare fields for the naming lexicon (bd tea-rags-mcp-0qaht):
 * `attr_reader :total` declares `@total`, `cattr_accessor :x` declares `@@x`.
 *
 *   | accessor operand declares            | field row |
 *   | ------------------------------------ | --------- |
 *   | instance methods (`attr_*`, …)       | `@x`      |
 *   | static methods (`cattr_*`, `mattr_*`) | `@@x`     |
 *
 * ONE field per operand, never one per synthesised method: `mount_uploader
 * :avatar` declares `@avatar`, not `@remove_avatar` or `@avatar_cache`, and a
 * writer's `x=` and a reader's `x` are the same field. The macro set is the DSL
 * catalogue's `accessor` category, read through the same dispatch the symbol
 * pass uses (`classBodyMacroOperands`) and gated by the project's Gemfile —
 * never a hard-coded name list. The type is not read here: a sink-time join
 * (`fieldTypeOf`) reads it off the ivar the class assigns.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierDeclaration } from "../../../../../contracts/types/codegraph.js";
import { innermostChunkSymbolId, type ExtractionFacetPass } from "../../../kernel/index.js";
import { catalogueForGemfile } from "../../gemfile.js";
import { classBodyMacroOperands } from "../macro-expansion.js";

export const rubyAccessorFieldFacetPass: ExtractionFacetPass = {
  run: (root, ctx) => {
    if (ctx.chunks.length === 0) return {};
    const catalogue = catalogueForGemfile(ctx.gemfileContent);
    const declarations: IdentifierDeclaration[] = [];
    const seen = new Set<string>();
    const stack: AstNode[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      for (const { operand, category, kind, startLine: line } of classBodyMacroOperands(node, catalogue)) {
        if (category !== "accessor") continue;
        const name = `${kind === "static" ? "@@" : "@"}${operand}`;
        const ownerSymbolId = innermostChunkSymbolId(line, ctx.chunks);
        if (ownerSymbolId === undefined) continue;
        const key = `${ownerSymbolId}\u0000${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        declarations.push({ name, kind: "field", line, ownerSymbolId });
      }
      const { children } = node;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return declarations.length > 0 ? { identifierDeclarations: declarations } : {};
  },
};
