/**
 * Ruby class-hierarchy extraction.
 *
 * Two views of the same declarations, both produced by a namespace-stack walk
 * over `class` / `module` nodes:
 *
 *   - {@link collectRubyInheritanceEdges} — the unified `InheritanceEdgeDecl`
 *     list with precise `super` / `include` / `extend` / `prepend` kinds, which
 *     the hierarchy graph consumes.
 *   - {@link collectRubyClassAncestors} — the flat per-kind Records the resolver
 *     reads (ancestors, prepended, superclasses, compact-declared FQs, and the
 *     `self.table_name` schema override).
 *
 * Both share the mixin-statement reader below, so a heritage form recognised by
 * one is recognised by the other.
 *
 * TWO THINGS SPELLED "EXTEND", and this file produces both — keep them apart:
 *
 *   - `class Foo < Bar` is SUPERCLASS inheritance. It fills the `superclasses`
 *     Record here and travels as `kind: "super"` on the edges; the walker
 *     publishes it as `FileExtraction.classExtends`, the cross-language field
 *     where "extends" means the JS/TS/Java single-inheritance parent.
 *   - `extend Mod` is Ruby's class-method MIXIN. It is one of the three mixin
 *     keywords, travels as `kind: "extend"`, and is folded into the flat
 *     `ancestors` list. It never touches `superclasses`.
 *
 * Naming them both "extends" is what invites reading a mixin as a superclass,
 * which then feeds every `super` resolution downstream.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { InheritanceEdgeDecl } from "../../../../contracts/types/codegraph.js";
import { lexicalScopeFqName, readScopeResolution } from "./ast-utils.js";

/**
 * Collect class-hierarchy edges with precise kinds (bd tea-rags-mcp-lz8t):
 * `class Foo < Bar` → `super`, `include Mod` → `include`, `extend Mod` →
 * `extend`, `prepend Mod` → `prepend`. `ordinal` preserves declaration order
 * WITHIN each kind (the cross-kind MRO position is encoded by the kind itself,
 * ranked downstream in MapHierarchyView). Source names are fully qualified by
 * enclosing module scope, matching `collectRubyDefinedConstants`.
 *
 * Mirrors `collectRubyClassAncestors`'s traversal (superclass extraction +
 * `mixinTargetFromStatement`) but emits the unified InheritanceEdgeDecl shape
 * instead of the flat per-kind Maps. Returns an empty array when no class /
 * module declares any heritage.
 */
export function collectRubyInheritanceEdges(root: AstNode): InheritanceEdgeDecl[] {
  const edges: InheritanceEdgeDecl[] = [];
  const constRe = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = lexicalScopeFqName(scope, localName);
      // Superclass — only `class` carries a `< Bar` clause; `module` never does.
      if (node.type === "class") {
        const sup = node.childForFieldName("superclass");
        if (sup) {
          for (const child of sup.namedChildren) {
            if (child.type === "constant" || child.type === "scope_resolution") {
              const supText = child.type === "scope_resolution" ? readScopeResolution(child) : child.text;
              if (supText && constRe.test(supText)) {
                edges.push({ source: fq, ancestor: supText, kind: "super", ordinal: 0 });
              }
              break;
            }
          }
        }
      }
      // Mixins — per-kind ordinal counter so each channel records its own
      // declaration order independently (parity with TS implements ordinals).
      const body = node.childForFieldName("body");
      const stmtSource = body ? body.children : node.children;
      const ordinals: Record<"include" | "extend" | "prepend", number> = { include: 0, extend: 0, prepend: 0 };
      for (const stmt of stmtSource) {
        const mixin = mixinTargetFromStatement(stmt);
        if (mixin) {
          edges.push({ source: fq, ancestor: mixin.name, kind: mixin.kind, ordinal: ordinals[mixin.kind]++ });
          continue;
        }
        // `class << self` (singleton_class) — descend its body and attribute
        // any include/extend/prepend inside it to the enclosing class/module.
        // Pattern: `module M; class << self; include Configurable; end; end`
        // emits an ancestor edge `M → Configurable` (bd tea-rags-mcp-08tss).
        if (stmt.type === "singleton_class") {
          const singBody = stmt.childForFieldName("body");
          const singStmts = singBody ? singBody.children : stmt.children;
          for (const singStmt of singStmts) {
            const singMixin = mixinTargetFromStatement(singStmt);
            if (!singMixin) continue;
            edges.push({
              source: fq,
              ancestor: singMixin.name,
              kind: singMixin.kind,
              ordinal: ordinals[singMixin.kind]++,
            });
          }
        }
      }
      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return edges;
}

/**
 * Walk class declarations to extract `className → ancestor[]` where the
 * first ancestor is the explicit superclass (Ruby's `class Foo < Bar`)
 * and the remaining entries are modules mixed in via `include Mod`
 * inside the class body. `extend Mod` (class-method mixin) and
 * `prepend Mod` (pre-pended ancestor) are also recognised — both
 * contribute to method lookup chains.
 *
 * Returns an empty map when no class declarations or no mixins exist.
 * Mixin module references are emitted as the textual qualified name
 * the source uses (`PaginatableForm` or `Acme::Concern::Trackable`).
 *
 * `superclasses` holds ONLY the `class Foo < Bar` parent — the `extend Mod`
 * mixin is a different declaration and lives in `ancestors` with the includes
 * (see the file header).
 */
export function collectRubyClassAncestors(root: AstNode): {
  ancestors: Map<string, string[]>;
  prepended: Map<string, string[]>;
  superclasses: Map<string, string>;
  compact: Set<string>;
  schemaTables: Map<string, string>;
} {
  const out = new Map<string, string[]>();
  const prependedOut = new Map<string, string[]>();
  /** class FQ → the `class Foo < Bar` parent. NOT the `extend Mod` mixin. */
  const superclassOut = new Map<string, string>();
  /** class FQ → explicit `self.table_name` override (bd tea-rags-mcp-8l5fo). */
  const schemaTablesOut = new Map<string, string>();
  // FQs declared in COMPACT form (`class A::B::C`): their intermediate namespaces
  // (A, A::B) are NOT open lexical scopes, so a raw ancestor must NOT be
  // prefix-walked through them (bd lawlq.3.7). Consumed by canonicalizeAncestorFq.
  const compactOut = new Set<string>();
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
      if (nameNode.type === "scope_resolution") compactOut.add(fq); // compact `class A::B::C`
      const ancestors: string[] = [];
      const prepended: string[] = [];
      // Direct superclass — tree-sitter-ruby wraps `< Bar` in a `superclass`
      // node whose first non-`<` child is the constant or scope_resolution.
      if (node.type === "class") {
        const sup = node.childForFieldName("superclass");
        if (sup) {
          for (const child of sup.namedChildren) {
            if (child.type === "constant" || child.type === "scope_resolution") {
              const supText = child.type === "scope_resolution" ? readScopeResolution(child) : child.text;
              if (supText && /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/.test(supText)) {
                ancestors.push(supText);
                superclassOut.set(fq, supText);
              }
              break;
            }
          }
        }
      }
      // Mixins — `include Mod`, `extend Mod`, `prepend Mod` calls inside
      // the class. The `body` field can be undefined when the grammar
      // attaches statements directly under the class node — scan both.
      // `prepend Mod` is collected separately (bd tea-rags-mcp-3jvn) because
      // it inserts BEFORE the class itself in Ruby's MRO — the resolver
      // checks prepended modules first, then the class, then includes/super.
      // `class << self` (singleton_class) bodies are also descended —
      // include/extend/prepend inside them contribute to the enclosing class
      // ancestor chain so `module M; class << self; include C; end; end`
      // populates classAncestors["M"] (bd tea-rags-mcp-08tss).
      const body = node.childForFieldName("body");
      const stmtSource = body ? body.children : node.children;
      for (const stmt of stmtSource) {
        const mixin = mixinTargetFromStatement(stmt);
        if (mixin) {
          if (mixin.kind === "prepend") prepended.push(mixin.name);
          else ancestors.push(mixin.name);
          continue;
        }
        if (stmt.type === "singleton_class") {
          const singBody = stmt.childForFieldName("body");
          const singStmts = singBody ? singBody.children : stmt.children;
          for (const singStmt of singStmts) {
            const singMixin = mixinTargetFromStatement(singStmt);
            if (!singMixin) continue;
            if (singMixin.kind === "prepend") prepended.push(singMixin.name);
            else ancestors.push(singMixin.name);
          }
        }
      }
      if (ancestors.length > 0) out.set(fq, ancestors);
      if (prepended.length > 0) prependedOut.set(fq, prepended);
      // `self.table_name = "companies"` — the explicit ORM table override
      // (bd tea-rags-mcp-8l5fo). Collected on THIS traversal (which already
      // owns the namespace stack that yields `fq`) rather than in a second walk.
      for (const stmt of stmtSource) {
        const table = schemaTableOverrideFromStatement(stmt);
        if (table !== null) schemaTablesOut.set(fq, table);
      }
      // Recurse — nested classes get their own ancestor maps. Children of
      // the body are the canonical recursion target; without an explicit
      // body field, fall back to scanning the class node's own children.
      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")]);
      return;
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return {
    ancestors: out,
    prepended: prependedOut,
    superclasses: superclassOut,
    compact: compactOut,
    schemaTables: schemaTablesOut,
  };
}

/**
 * The table a class-body statement declares as its ORM table:
 * `self.table_name = "companies"` (bd tea-rags-mcp-8l5fo). ONLY the
 * `self`-qualified assignment counts — a bare `table_name = "x"` is a local
 * variable, not the class-level override — and only a STRING literal: a computed
 * expression (`self.table_name = compute_name`) is unknowable statically, and a
 * guess would attach a whole table's columns to the wrong model.
 */
function schemaTableOverrideFromStatement(node: AstNode): string | null {
  if (node.type !== "assignment") return null;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return null;
  if (left.text.replace(/\s+/g, "") !== "self.table_name") return null;
  const literal = /^["']([A-Za-z0-9_.]+)["']$/.exec(right.text.trim());
  return literal?.[1] ?? null;
}

const RUBY_MIXIN_METHODS = new Set(["include", "extend", "prepend"]);

function mixinTargetFromStatement(node: AstNode): { name: string; kind: "include" | "extend" | "prepend" } | null {
  if (node.type !== "call" && node.type !== "method_call") return null;
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
  if (!methodField || !RUBY_MIXIN_METHODS.has(methodField.text)) return null;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  const text =
    firstArg.type === "constant"
      ? firstArg.text
      : firstArg.type === "scope_resolution"
        ? readScopeResolution(firstArg)
        : null;
  if (!text || !/^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/.test(text)) return null;
  return { name: text, kind: methodField.text as "include" | "extend" | "prepend" };
}
