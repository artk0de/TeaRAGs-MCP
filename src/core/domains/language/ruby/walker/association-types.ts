/**
 * Rails association macros, read two ways.
 *
 * `belongs_to :author, class_name: "User"` names an ACCESSOR (`author`) and a
 * MODEL (`User`), and the walker needs both: the accessor keys the per-class
 * association map that types compound receiver chains (`event.user.agents`),
 * while the model constant is what the synthetic model-reference edge points
 * at. {@link associationAccessorName} and {@link associationModelConstant} are
 * that pair, and {@link collectRubyAssociationTypes} is the scope-stack walk
 * that assembles them into the `associationTypes` channel.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import { singularizeAssociation } from "../dsl/index.js";
import { readScopeResolution } from "./ast-utils.js";
import { YARD_CONST } from "./type-sources/yard.js";

/**
 * AR / controller association macros whose first symbol argument names an
 * associated MODEL (duzy). `has_many :posts` references the `Post` model;
 * the walker emits a constant-ref CallRef to that model so the association
 * declaration carries a file→file edge to the model file (mirrors the
 * registry-constant-ref discipline). Method-accessor synthesis for these
 * (`User#posts` etc.) lives in `name-of.ts` `AR_ASSOCIATION_MACROS`.
 */
export const RUBY_ASSOCIATION_MACROS = new Set(["has_many", "has_one", "belongs_to", "has_and_belongs_to_many"]);

/**
 * Camelize a snake_case association base into a Ruby class name (duzy):
 * `blog_posts` → `BlogPost`. The caller singularizes first; this only
 * upcases each `_`-separated segment's first char and joins.
 */
export function camelizeModelName(snake: string): string {
  return snake
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * The accessor name a Rails association macro declares — its FIRST symbol
 * argument verbatim (`belongs_to :user` → `user`, `has_many :blog_posts` →
 * `blog_posts`). This is the convention reader/writer name, NOT singularized
 * (the model constant is derived separately by {@link associationModelConstant},
 * which DOES singularize + honour `class_name:`). Returns `null` when the call
 * has no leading symbol argument (no accessor to name). Exported so the
 * association-map builder keys the map on the same accessor text the call-site
 * receiver uses (`event.user`).
 */
export function associationAccessorName(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (firstArg?.type !== "simple_symbol") return null;
  const base = firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  return base.length > 0 ? base : null;
}

/**
 * Resolve the associated model constant for an association macro call
 * (duzy). An explicit `class_name: 'Foo'` / `class_name: "Acme::Bar"`
 * kwarg wins verbatim (the canonical AR override); otherwise the first
 * symbol argument is singularized + camelized by Rails convention. Returns
 * `null` when neither a usable `class_name:` string nor a leading symbol
 * argument is present — no model edge can be synthesised syntactically.
 */
export function associationModelConstant(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  // Explicit `class_name:` override — a string literal constant.
  for (const arg of args.namedChildren) {
    if (arg.type !== "pair") continue;
    const key = arg.childForFieldName("key");
    if (key?.text !== "class_name") continue;
    const value = arg.childForFieldName("value");
    if (!value) continue;
    if (value.type === "string" || value.type === "string_literal") {
      const inner = value.namedChildren.find((c) => c.type === "string_content");
      const literal = inner ? inner.text : value.text.replace(/^["']|["']$/g, "");
      return YARD_CONST.test(literal) ? literal : null;
    }
    if (value.type === "constant") return value.text;
    if (value.type === "scope_resolution") return readScopeResolution(value);
  }
  // Convention: first symbol argument → singularize + camelize.
  const firstArg = args.namedChildren[0];
  if (firstArg?.type !== "simple_symbol") return null;
  const base = firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  if (base.length === 0) return null;
  const model = camelizeModelName(singularizeAssociation(base));
  return model.length > 0 ? model : null;
}

/**
 * Per-class Rails association map for the `associationTypes` channel (B1):
 * `className → accessorName → modelType`. Mirrors {@link collectRubyIvarFieldTypes}'s
 * scope-stack walk — each class / module records its OWN class-body association
 * macros (`belongs_to`/`has_one`/`has_many`/`has_and_belongs_to_many`); nested
 * classes get their own fq map. For each macro call the accessor name is the
 * first symbol verbatim ({@link associationAccessorName}) and the model type is
 * {@link associationModelConstant} — so an explicit `class_name:` override is
 * honoured (`belongs_to :author, class_name: "User"` → `author → User`, NOT
 * `Author`). The class key is the fully-qualified scope-stack name
 * (`Outer::Inner`), matching `collectRubyClassAncestors` and the resolver's
 * `ctx.callerScope.join("::")`. Only class-body macro calls (no receiver, or a
 * `self` receiver) record; an instance call `obj.has_many` is ignored.
 * Within-class conflict is last-write-wins (source-order DFS).
 */
export function collectRubyAssociationTypes(root: AstNode): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
      const body = node.childForFieldName("body");

      // Collect association macros across THIS class's own body. Stop at any
      // nested class/module — those are attributed to their own fq below.
      const assocs: Record<string, string> = {};
      const collectAssocs = (n: AstNode): void => {
        if (n.type === "class" || n.type === "module") return;
        if (n.type === "call" || n.type === "method_call") {
          const method = n.childForFieldName("method");
          const receiver = n.childForFieldName("receiver");
          // Class-body macro form only: bare call or explicit `self` receiver.
          const isClassBodyForm = !receiver || receiver.type === "self";
          if (method && isClassBodyForm && RUBY_ASSOCIATION_MACROS.has(method.text)) {
            const accessor = associationAccessorName(n);
            const model = associationModelConstant(n);
            if (accessor !== null && model !== null) assocs[accessor] = model; // last-write-wins
          }
        }
        for (const child of n.children) collectAssocs(child);
      };
      for (const child of (body ?? node).children) collectAssocs(child);
      if (Object.keys(assocs).length > 0) out[fq] = { ...(out[fq] ?? {}), ...assocs };

      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return out;
}
