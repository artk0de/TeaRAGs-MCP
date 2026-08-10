/**
 * Recognition of the TypeScript / JavaScript **const-object namespace**:
 *
 *   export const FileLevelGrouper = {
 *     group(results, limit) { … },
 *   };
 *
 * A widely-used alternative to a static-only class. Its members are invoked as
 * `X.member()` on the object itself, so per `.claude/rules/symbolid-convention.md`
 * they compose with the namespace `.` — there is no instance to bind, which is
 * why `classifyMethod` declines to classify them (see `classify.js`).
 *
 * Lives in `infra/symbolid` for the same reason `classifyMethod` does: TWO
 * consumers must answer this question identically or they fall out of lockstep.
 *
 *   1. The codegraph walker (`domains/language/typescript/walker/name-of.ts`)
 *      names the declarator so members compose as `X.member` in
 *      `cg_symbols.symbol_id` (bd tea-rags-mcp-2jhwk).
 *   2. The chunker (`domains/ingest/pipeline/chunker/tree-sitter.ts`) writes the
 *      SAME id into the Qdrant payload `symbolId` (bd tea-rags-mcp-62hzr).
 *
 * When 2jhwk fixed only the walker, the two disagreed for every const-object
 * namespace in the repo: search returned `symbolId: "group"` while the graph row
 * was keyed `FileLevelGrouper.group`, so `get_callers` on a copied id returned
 * `[]`. One implementation, two entry points, is the only way that stays fixed.
 */

import type { AstNode } from "../../contracts/types/ast.js";

/**
 * The namespace name a `variable_declarator` declares, or null when the
 * declarator is not a const-object namespace.
 *
 * Gated on the object carrying at least one `method_definition`: a data-only
 * object (`const PALETTE = { red: "#f00" }`) declares nothing callable, and
 * naming it would add symbols no call site can ever target.
 */
export function constObjectNamespaceName(declarator: AstNode): string | null {
  if (declarator.type !== "variable_declarator") return null;
  const id = declarator.childForFieldName("name");
  // `const { a, b } = …` binds an `object_pattern`, which names no namespace.
  if (id?.type !== "identifier") return null;
  const value = declarator.childForFieldName("value");
  if (!value) return null;
  const object = unwrapTypeAssertions(value);
  if (object.type !== "object") return null;
  if (!object.children.some((child) => child.type === "method_definition")) return null;
  return id.text;
}

/**
 * The const-object namespace that DECLARES `method`, or null when the method is
 * not a direct member of one (a class method, or a method on a nested object
 * literal).
 *
 * Requires the method to be a DIRECT child of the declared object. A nested
 * `{ inner: { deep() {} } }` is deliberately declined — naming the outer would
 * claim a member it does not own, and the walker declines it for the same
 * reason, so accepting it here would break the lockstep in the other direction.
 */
export function constObjectNamespaceOwner(method: AstNode): string | null {
  if (method.type !== "method_definition") return null;
  const object = method.parent;
  if (object?.type !== "object") return null;
  // Step past the type-level wrappers the declarator's value may carry.
  let current: AstNode | null = object.parent;
  while (
    current?.type === "as_expression" ||
    current?.type === "satisfies_expression" ||
    current?.type === "parenthesized_expression"
  ) {
    current = current.parent;
  }
  if (!current) return null;
  return constObjectNamespaceName(current);
}

/**
 * Peel the TypeScript-only wrappers that sit between a declarator's `value`
 * field and the object literal underneath: `as const` / `as Shape`
 * (`as_expression`), `satisfies Shape` (`satisfies_expression`), and explicit
 * parentheses. All three are type-level annotations — the declared value is
 * still the object literal, so the namespace shape must be recognised through
 * them.
 */
function unwrapTypeAssertions(node: AstNode): AstNode {
  let current = node;
  // Bounded by the AST depth of the wrapper chain; each step strips one level.
  while (
    current.type === "as_expression" ||
    current.type === "satisfies_expression" ||
    current.type === "parenthesized_expression"
  ) {
    // `namedChildren[0]` is the wrapped expression in all three shapes; using
    // it rather than `children[0]` skips the anonymous punctuation tokens
    // (`(`, `as`, `satisfies`) tree-sitter keeps in the full child list.
    const inner = current.namedChildren[0];
    if (!inner || inner === current) break;
    current = inner;
  }
  return current;
}
