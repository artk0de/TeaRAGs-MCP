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

/**
 * Whether a class body declares NO behaviour of its own (bd tea-rags-mcp-44cpv,
 * decision c-1=a, 2026-10-11): every member is a constructor, a data property
 * or an accessor. Such a class is a thrown value no dependent substitutes — an
 * `Error` subclass — or a data carrier — a record shape, a dataclass — and the
 * census counts it in NEITHER bucket, mirroring how the TypeScript pass already
 * keeps a data-shape interface out of both.
 *
 * The rule is uniform over member KINDS, never over spellings: no branch reads
 * `extends Error` — a data-only class and an exception subclass are the same
 * reading. The boundary calls, per decision c-1:
 *
 * - a static method, or a property whose value is a function (an arrow, a
 *   function expression, a lambda), is BEHAVIOUR — the class stays concrete;
 * - a static constant/data property is DATA (static readonly / static let /
 *   a primitive-valued field);
 * - a constructor parameter property (`constructor(private x)`) is a FIELD;
 * - accessors alone (getters/setters, `@property` accessors) are DATA;
 * - an initializer block (`static { … }`, a Java static initializer) is DATA —
 *   it initializes, it is not a member a dependent calls;
 * - abstract classes, interfaces/protocols and decorated abstract declarations
 *   keep their existing reading — an abstract class stays abstract whatever its
 *   members.
 *
 * Which member is behaviour stays language knowledge: each pass supplies
 * `memberDeclaresBehaviour` over its own grammar's class-body members. A body
 * that is missing (an error-tolerant parse of a truncated class) has no member
 * that declares behaviour and reads as behaviour-free — the safe default, and
 * the reading an empty class body takes too: zero members is the degenerate
 * constructor-and-fields-only class.
 */
export function isBehaviourFreeClassBody(
  body: AstNode | null | undefined,
  memberDeclaresBehaviour: (member: AstNode) => boolean,
): boolean {
  return !body?.namedChildren.some(memberDeclaresBehaviour);
}

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
