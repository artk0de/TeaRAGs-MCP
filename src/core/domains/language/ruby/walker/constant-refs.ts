/**
 * Ruby's two import-discovery channels, plus the constant declarations that
 * make the second one resolvable.
 *
 *   - {@link collectRubyRequires} — explicit `require` / `require_relative`.
 *   - {@link collectRubyConstantRefs} — Zeitwerk autoload references, emitted
 *     with the {@link ZEITWERK_PREFIX} marker so the resolver switches from
 *     load-path resolution to constant-to-file inference.
 *   - {@link collectRubyDefinedConstants} — the constants this file DEFINES,
 *     which the provider's symbol table indexes for that inference.
 *
 * The declaration-vs-reference split is what keeps the two apart: a constant in
 * a class header belongs to `fileScope`, the same constant at a call site
 * belongs to `imports`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ImportRef } from "../../../../contracts/types/codegraph.js";
import { readScopeResolution, walk } from "./ast-utils.js";

/** Prefix marker the resolver uses to recognise Zeitwerk constant refs. */
export const ZEITWERK_PREFIX = "zeitwerk:";

/**
 * `require 'foo'`, `require_relative './foo'`. Tree-sitter-ruby emits
 * these as `call` nodes with method = "require" / "require_relative"
 * and a string argument.
 */
export function collectRubyRequires(root: AstNode): ImportRef[] {
  const out: ImportRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call" && node.type !== "method_call") return;
    const method = node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
    if (!method) return;
    const name = method.text;
    if (name !== "require" && name !== "require_relative") return;
    const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
    if (!args) return;
    const stringArg = args.namedChildren.find((c) => c.type === "string" || c.type === "string_literal");
    if (!stringArg) return;
    // Strip the quotes from "foo" or 'foo'. tree-sitter-ruby wraps
    // string content in nested string_content; fall back to the raw
    // text minus the outer quote chars.
    const inner = stringArg.namedChildren.find((c) => c.type === "string_content");
    const literal = inner ? inner.text : stringArg.text.replace(/^["']|["']$/g, "");
    // Normalise relative-require prefix: strip any leading "./" in
    // the literal before re-applying the canonical "./" marker so
    // both `require_relative 'foo'` and `require_relative './foo'`
    // produce the same importText shape ("./foo"). Without this
    // normalisation the literal "./foo" would double-prefix to
    // "././foo" and the resolver's basename match misfires.
    const cleanLiteral = literal.replace(/^\.\//, "");
    const prefix = name === "require_relative" ? "./" : "";
    out.push({ importText: prefix + cleanLiteral, startLine: node.startPosition.row + 1 });
  });
  return out;
}

/**
 * Zeitwerk autoload references — every place a constant like `User` or
 * `Acme::Auth::Login` is mentioned. The walker emits one ImportRef per
 * unique top-level constant per chunk so the file's "imports" reflect
 * its actual symbol-graph dependencies.
 *
 * Tree-sitter-ruby parses `Acme::Auth::Login` as nested
 * `scope_resolution` nodes — we read the leftmost root and reconstruct
 * the full chain via text. Single-segment references (`User.find`)
 * appear as `constant` nodes.
 */
export function collectRubyConstantRefs(root: AstNode): ImportRef[] {
  const seen = new Set<string>();
  const out: ImportRef[] = [];
  walk(root, (node) => {
    // Skip constants in declaration positions (the file's OWN
    // class/module definitions) — they belong in fileScope, not imports.
    if (isInDeclarationPosition(node)) return;
    let qualified: string | null = null;
    const startLine = node.startPosition.row + 1;
    if (node.type === "scope_resolution") {
      // Only emit for the OUTERMOST scope_resolution to avoid
      // emitting `Acme`, `Acme::Auth`, AND `Acme::Auth::Login` for
      // one reference. The parent check filters nested fragments.
      if (node.parent?.type === "scope_resolution") return;
      qualified = readScopeResolution(node);
    } else if (node.type === "constant") {
      if (node.parent?.type === "scope_resolution") return; // covered by outer
      qualified = node.text;
    }
    if (!qualified) return;
    const key = `${qualified}@${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ importText: ZEITWERK_PREFIX + qualified, startLine });
  });
  return out;
}

/**
 * Whether a constant/scope_resolution node sits in a context where it
 * DECLARES something (class header, module header, assignment target,
 * superclass position) rather than REFERENCES something. Declarations
 * are exported via fileScope; references via imports.
 */
function isInDeclarationPosition(node: AstNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "class" || p.type === "module") {
      // Class/module HEADER constant is a declaration, but the SUPERCLASS
      // and any references inside the body are not.
      const nameField = p.childForFieldName("name");
      const superField = p.childForFieldName("superclass");
      if (nameField === node || isAncestor(nameField, node)) return true;
      if (superField === node || isAncestor(superField, node)) return false; // superclass is a reference
      return false;
    }
    if (p.type === "assignment") {
      // `User = Struct.new(...)` — the LHS constant is a declaration.
      const lhs = p.childForFieldName("left");
      if (lhs === node || isAncestor(lhs, node)) return true;
      return false;
    }
    p = p.parent;
  }
  return false;
}

function isAncestor(maybeParent: AstNode | null, child: AstNode): boolean {
  if (!maybeParent) return false;
  let p: AstNode | null = child;
  while (p) {
    if (p === maybeParent) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Constants this file defines, in fully-qualified form. Used by the
 * resolver to map a `User` reference back to `app/models/user.rb`.
 *
 * Walks class/module declarations, building a scope stack so nested
 * declarations produce qualified names. Example:
 *   class Acme::Auth
 *     class User
 *     end
 *   end
 * → ["Acme::Auth", "Acme::Auth::User"]
 */
export function collectRubyDefinedConstants(root: AstNode): string[] {
  const out: string[] = [];
  const walkScope = (node: AstNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
        const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
        out.push(fq);
        // Recurse with the body's scope extended by the new constant.
        const body = node.childForFieldName("body");
        if (body) walkScope(body, [...scope, ...localName.split("::")]);
        return;
      }
    }
    for (const child of node.children) walkScope(child, scope);
  };
  walkScope(root, []);
  return out;
}
