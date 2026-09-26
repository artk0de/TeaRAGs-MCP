/**
 * The declared-visibility facet (bd tea-rags-mcp-jwjyr.1) — fills
 * `ChunkExtraction.visibility` for a language whose native walker leaves it
 * absent, as an extraction PASS (`extraction-passes.ts`, Model A) rather than a
 * clause in each language's monolith.
 *
 * What a declaration's access level IS stays language knowledge: each language
 * supplies a {@link DeclaredVisibilityReader} that recognises its own
 * declaration nodes and maps their modifiers onto the three-value union. The
 * neutral half — one traversal, then the join of each reading onto the chunk
 * `collectSymbols` produced for the same node — is shared here, so no language
 * re-derives the join and none can skew it.
 *
 * The join: `collectSymbols` stamps a chunk with the start line of the node the
 * language's `nameOf` named, and composes its symbolId so that it ENDS with that
 * name. A reading therefore lands on the chunk that starts on the reading's line
 * and whose id (overload suffix `~N` stripped) is the name or ends with it after
 * a separator. A reading no chunk matches is dropped — a pass never synthesizes a
 * chunk (`mergeChunks` would append it as a new one).
 *
 * `mergeExtraction` folds `visibility` as `base ?? pass`, so a native walker that
 * already records visibility (Ruby) always wins over a pass.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { ChunkExtraction, FileExtraction } from "../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "./extraction-passes.js";
import { symbolIdNames } from "./symbol-id.js";

export type DeclaredVisibility = NonNullable<ChunkExtraction["visibility"]>;

/** One declaration's access level, under the name its `nameOf` gives it. */
export interface DeclaredVisibilityReading {
  readonly name: string;
  readonly visibility: DeclaredVisibility;
}

/**
 * A language's reading of one node: its declared access level when the node is
 * a declaration the language's `nameOf` names AND the language can state the
 * level; `null` otherwise (not a declaration, or no provable answer — a Java
 * package-private member, a Python `_name`).
 */
export type DeclaredVisibilityReader = (node: AstNode) => DeclaredVisibilityReading | null;

export function declaredVisibilityFacetPass(read: DeclaredVisibilityReader): ExtractionFacetPass {
  return {
    run: (root, ctx): Partial<FileExtraction> => {
      if (ctx.chunks.length === 0) return {};
      const readingsByLine = new Map<number, DeclaredVisibilityReading[]>();
      const stack: AstNode[] = [root];
      for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        const reading = read(node);
        if (reading !== null) {
          const line = node.startPosition.row + 1;
          const onLine = readingsByLine.get(line);
          if (onLine === undefined) readingsByLine.set(line, [reading]);
          else onLine.push(reading);
        }
        for (const child of node.children) stack.push(child);
      }
      if (readingsByLine.size === 0) return {};
      const chunks: ChunkExtraction[] = [];
      for (const chunk of ctx.chunks) {
        const hit = readingsByLine.get(chunk.startLine)?.find((r) => symbolIdNames(chunk.symbolId, r.name));
        if (hit !== undefined) {
          chunks.push({ symbolId: chunk.symbolId, scope: chunk.scope, calls: [], visibility: hit.visibility });
        }
      }
      return chunks.length > 0 ? { chunks } : {};
    },
  };
}
