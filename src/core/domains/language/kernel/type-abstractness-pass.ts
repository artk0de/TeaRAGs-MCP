/**
 * The type-abstractness census facet (bd tea-rags-mcp-r8hme.8) — counts, per
 * file, the types that declare behaviour without implementing it (ABSTRACT) and
 * the types that implement it (CONCRETE). Summed over a component it gives
 * Martin's abstractness A = abstract / (abstract + concrete), the second axis of
 * the main sequence the architecture report judges.
 *
 * Which declaration is which stays language knowledge: each language supplies a
 * {@link TypeAbstractnessReader} that recognises its own type declarations. A
 * declaration the reader answers `null` for is not a type Martin would count —
 * a data-shape interface, a namespace module, an extension re-opening another
 * type — and is left out of both counts rather than guessed. The neutral half,
 * one traversal and the two counters, is shared here so no language re-derives
 * it. Nested declarations count on their own, as Martin counts every class.
 * Only NAMED nodes are visited: a keyword token (`class`, `module`) shares its
 * spelling with a declaration node type in some grammars.
 *
 * The census is emitted even when both counts are 0: "the census ran and found
 * no type" is a measurement, which the store keeps apart from NULL — a row
 * written before the census existed.
 *
 * `mergeExtraction` folds `typeAbstractness` as `base ?? pass`: one pass owns
 * the census of a file.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "./extraction-passes.js";

export type TypeAbstractnessVerdict = "abstract" | "concrete";

/**
 * A language's reading of one node: `abstract` or `concrete` when the node
 * declares a type that counts, `null` for every other node.
 */
export type TypeAbstractnessReader = (node: AstNode) => TypeAbstractnessVerdict | null;

export function typeAbstractnessFacetPass(read: TypeAbstractnessReader): ExtractionFacetPass {
  return {
    run: (root): Partial<FileExtraction> => {
      let abstractTypeCount = 0;
      let concreteTypeCount = 0;
      const stack: AstNode[] = [root];
      for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        const verdict = read(node);
        if (verdict === "abstract") abstractTypeCount++;
        else if (verdict === "concrete") concreteTypeCount++;
        for (const child of node.namedChildren) stack.push(child);
      }
      return { typeAbstractness: { abstractTypeCount, concreteTypeCount } };
    },
  };
}
