/**
 * The two filters that decide whether a bare Ruby `identifier` is a method call
 * (bd tea-rags-mcp-hbie).
 *
 * Ruby lets `foo` stand for `foo()`, so every identifier is a candidate call
 * site and something has to rule the others out:
 *
 *   - {@link isBareIdentifierCallSite} — SYNTACTIC position. A parameter name,
 *     an assignment target, a rescue variable and a `def` name are all bindings,
 *     not calls.
 *   - {@link collectMethodLocalBindings} — SCOPE. `prs` after `prs = {}` reads a
 *     local, whatever position it sits in.
 *
 * They are deliberately separate: position is a property of one node, the
 * binding set is a property of the whole enclosing method body.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";

/**
 * Whether an `identifier` node sits in a call-position role suitable for
 * bare-identifier method emission. Excludes positions where the identifier
 * is a declaration site (method/parameter name, assignment LHS) or already
 * accounted-for by the `call`/`method_call` emission path (the call's own
 * `method` / `receiver` field). Local-variable READS that look like calls
 * (`prs` after `prs = {}`) are filtered separately via the localBindings
 * set in the parent walker — this guard only filters by syntactic position.
 */
export function isBareIdentifierCallSite(id: AstNode): boolean {
  const { parent } = id;
  if (!parent) return false;
  // Method / singleton_method's own name field — `def foo` not a call.
  if (parent.type === "method" || parent.type === "singleton_method") {
    if (parent.childForFieldName("name") === id) return false;
  }
  // call / method_call own field references — handled by the call branch.
  if (parent.type === "call" || parent.type === "method_call") {
    if (parent.childForFieldName("method") === id) return false;
    if (parent.childForFieldName("receiver") === id) return false;
  }
  // Assignment LHS introduces a local. RHS identifier IS a call site.
  if (parent.type === "assignment" && parent.childForFieldName("left") === id) return false;
  // `*rest` splat target in a multiple-assignment LHS — the identifier sits under
  // a `rest_assignment`; it is a binding, not a call (bd lawlq.3.7).
  if (parent.type === "rest_assignment") return false;
  // `prs[:k]` — element_reference's "object" position is the bound local
  // being indexed, not a call. Skip regardless of fieldName (the grammar
  // sometimes omits an explicit object field on this node).
  if (parent.type === "element_reference") {
    const first = parent.namedChildren[0];
    if (first === id) return false;
  }
  // Parameter declarations of any flavor: `(x, y)`, `(name:)`, `(*splat)`,
  // `(**kw)`, `(&block)`. The grammar wraps optional/keyword/destructured
  // forms in dedicated nodes; the bare-identifier-in-method_parameters
  // form covers required positional params.
  if (parent.type === "method_parameters" || parent.type === "block_parameters") return false;
  if (
    parent.type === "optional_parameter" ||
    parent.type === "keyword_parameter" ||
    parent.type === "splat_parameter" ||
    parent.type === "hash_splat_parameter" ||
    parent.type === "block_parameter"
  ) {
    // Only the `name` field is a binding; the `value` (default expression)
    // CAN contain a method call site, so let it fall through to general
    // emission rules.
    if (parent.childForFieldName("name") === id) return false;
  }
  // Rescue exception variable: `rescue StandardError => e`.
  if (parent.type === "exception_variable") return false;
  // `for item in coll` — pattern field is the loop variable.
  if (parent.type === "for" && parent.childForFieldName("pattern") === id) return false;
  return true;
}

/**
 * Collect every identifier name that the given `method` / `singleton_method`
 * definition introduces into its body scope: parameters of all flavors,
 * assignment LHS within the body, block parameters of inner blocks, rescue
 * exception variables, and `for var in coll` loop variables. Used by the
 * bare-identifier emission path to suppress emissions for local-variable
 * reads.
 *
 * Local-variable scoping in Ruby is method-level: a `prs = {}` assignment
 * at any depth inside `def foo` binds `prs` for the entire method body.
 * Block parameters are scoped to their block but conservatively folded
 * into the method-level set here — the cost is a few missed bare-call
 * edges (where a method-level name happens to collide with a block var),
 * which the resolver's existing language + scope filters would have
 * dropped anyway.
 */
export function collectMethodLocalBindings(methodNode: AstNode): Set<string> {
  const out = new Set<string>();
  const walkBindings = (node: AstNode): void => {
    if (node.type === "method_parameters" || node.type === "block_parameters") {
      for (const child of node.namedChildren) collectParamName(child, out);
    }
    if (node.type === "assignment") {
      const lhs = node.childForFieldName("left");
      if (lhs?.type === "identifier") out.add(lhs.text);
      // `a, b = x` — multiple assignment: the LHS is a `left_assignment_list`
      // of targets. Only bare `identifier` children bind a fresh local; an
      // `element_reference` (`h[k]`) or `call` (`obj.attr =`) target reuses an
      // existing binding, so it is skipped (bd lawlq.3.1).
      if (lhs?.type === "left_assignment_list") {
        for (const target of lhs.namedChildren) {
          if (target.type === "identifier") out.add(target.text);
          // `*rest` splat target — a `rest_assignment` wraps the bound identifier;
          // it is a fresh local, not a call site (bd lawlq.3.7).
          else if (target.type === "rest_assignment") {
            const inner = target.namedChildren.find((c) => c.type === "identifier");
            if (inner) out.add(inner.text);
          }
        }
      }
      // `prs[:k] = v` — element_reference LHS doesn't bind a new local
      // (prs was already bound earlier), so no add here.
    }
    if (node.type === "exception_variable") {
      const inner = node.namedChildren[0];
      if (inner?.type === "identifier") out.add(inner.text);
    }
    if (node.type === "for") {
      const pat = node.childForFieldName("pattern");
      if (pat?.type === "identifier") out.add(pat.text);
    }
    // Recurse into children EXCEPT a nested method/singleton_method —
    // those open fresh scopes and are handled by their own walker visit.
    if (node !== methodNode && (node.type === "method" || node.type === "singleton_method")) return;
    for (const child of node.children) walkBindings(child);
  };
  walkBindings(methodNode);
  return out;
}

/**
 * Pull a parameter's bound name out of a single child of `method_parameters`
 * or `block_parameters`. Required positional params are bare `identifier`;
 * optional/keyword/splat/hash-splat/block params wrap the identifier under
 * a typed node whose `name` field carries the binding.
 */
function collectParamName(node: AstNode, out: Set<string>): void {
  if (node.type === "identifier") {
    out.add(node.text);
    return;
  }
  // Destructured block param `|(a, b)|` — a `destructured_parameter` wraps the
  // bound names (possibly nested `|(a, (b, c))|`). Each is a block-local, not a
  // call site (bd lawlq.3.1).
  if (node.type === "destructured_parameter") {
    for (const child of node.namedChildren) collectParamName(child, out);
    return;
  }
  if (
    node.type === "optional_parameter" ||
    node.type === "keyword_parameter" ||
    node.type === "splat_parameter" ||
    node.type === "hash_splat_parameter" ||
    node.type === "block_parameter"
  ) {
    const name = node.childForFieldName("name");
    if (name?.type === "identifier") out.add(name.text);
  }
}
