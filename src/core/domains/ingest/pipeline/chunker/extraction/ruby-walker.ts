/**
 * Ruby extraction walker.
 *
 * Two import-discovery channels because Ruby has two distinct linking
 * regimes:
 *
 *   1. Explicit `require` / `require_relative` — emits an ImportRef
 *      with the literal string from the call. Resolver maps these to
 *      file paths via load-path heuristics (basename match) or
 *      file-relative paths.
 *
 *   2. Zeitwerk autoload (Rails / Hanami / Rodauth / modern gems) —
 *      no `require` at the use site. A reference like `User.find`
 *      depends on `User` being defined in `app/models/user.rb` (or
 *      `lib/user.rb`, etc.) per Zeitwerk's constant-to-filename rule.
 *      Discovery is two-phase:
 *
 *      a) Per file: emit `fileScope` = list of top-level constants
 *         this file DEFINES (class/module declarations, including
 *         nested under `class A::B`). The provider's symbol table
 *         indexes these.
 *      b) Per call site: when a constant reference appears (`User.find`,
 *         `Acme::Auth::Login.new`), emit an ImportRef with the full
 *         qualified-constant string PREFIXED with `zeitwerk:` so the
 *         resolver knows to do constant-to-file inference instead of
 *         load-path resolution.
 *
 * Output FileExtraction:
 *   - `imports[]` mixes explicit `require_relative './foo'`,
 *     `require 'foo'`, and Zeitwerk constant references.
 *   - `fileScope[]` holds constants this file defines (used by the
 *     resolver's reverse lookup).
 *   - `chunks[].calls[]` carries call sites for the method graph.
 */

import type Parser from "tree-sitter";

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../../contracts/types/codegraph.js";

export interface RubyExtractInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

/** Prefix marker the resolver uses to recognise Zeitwerk constant refs. */
export const ZEITWERK_PREFIX = "zeitwerk:";

export function extractFromRubyFile(input: RubyExtractInput): FileExtraction {
  const explicitImports = collectRubyRequires(input.tree.rootNode);
  const constantRefs = collectRubyConstantRefs(input.tree.rootNode);
  const fileScope = collectRubyDefinedConstants(input.tree.rootNode);
  const calls = collectRubyCalls(input.tree.rootNode);
  const imports: ImportRef[] = [...explicitImports, ...constantRefs];
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => ({
    symbolId: c.symbolId,
    scope: c.scope,
    startLine: c.startLine,
    endLine: c.endLine,
    calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
  }));
  return {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope,
  };
}

/**
 * `require 'foo'`, `require_relative './foo'`. Tree-sitter-ruby emits
 * these as `call` nodes with method = "require" / "require_relative"
 * and a string argument.
 */
function collectRubyRequires(root: Parser.SyntaxNode): ImportRef[] {
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
function collectRubyConstantRefs(root: Parser.SyntaxNode): ImportRef[] {
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

function readScopeResolution(node: Parser.SyntaxNode): string {
  // scope_resolution has fields `scope` (left) and `name` (right).
  // Recurse on `scope` if it's another scope_resolution, otherwise
  // take its constant text.
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (!name) return "";
  const left =
    scope?.type === "scope_resolution" ? readScopeResolution(scope) : scope?.type === "constant" ? scope.text : "";
  return left ? `${left}::${name.text}` : name.text;
}

/**
 * Whether a constant/scope_resolution node sits in a context where it
 * DECLARES something (class header, module header, assignment target,
 * superclass position) rather than REFERENCES something. Declarations
 * are exported via fileScope; references via imports.
 */
function isInDeclarationPosition(node: Parser.SyntaxNode): boolean {
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

function isAncestor(maybeParent: Parser.SyntaxNode | null, child: Parser.SyntaxNode): boolean {
  if (!maybeParent) return false;
  let p: Parser.SyntaxNode | null = child;
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
function collectRubyDefinedConstants(root: Parser.SyntaxNode): string[] {
  const out: string[] = [];
  const walkScope = (node: Parser.SyntaxNode, scope: string[]): void => {
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

function collectRubyCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call" && node.type !== "method_call") return;
    const receiver = node.childForFieldName("receiver");
    const method = node.childForFieldName("method");
    if (!method) return;
    const startLine = node.startPosition.row + 1;
    if (receiver) {
      // `Foo.bar(...)` or `obj.method(...)`. For Zeitwerk-style
      // resolution, capture the receiver's text (which may itself be
      // a scope_resolution like `Acme::Auth`).
      const receiverText = receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
      out.push({ callText: node.text, receiver: receiverText, member: method.text, startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: method.text, startLine });
    }
  });
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
