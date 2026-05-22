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

/**
 * AR / ActiveRecord finder methods on a Model class that return a single
 * model INSTANCE (not a Relation). Used by `collectLocalBindingsForChunk`
 * to bind `var = Model.<finder>(...)` to the Model type. Methods like
 * `where` / `order` / `joins` return a Relation, so chained `.first` /
 * `.last` need separate Relation-aware tracking (not implemented here).
 */
const AR_INSTANCE_FINDERS = new Set(["find", "find_by", "find_by!", "create", "create!", "first", "last", "take"]);

/**
 * Env-gate for the Ruby local variable type inference path. When `false`,
 * walker emits `localBindings: undefined` and the resolver falls back to
 * legacy import + short-name resolution. Default `true`.
 */
function localTypeTrackingEnabled(): boolean {
  const raw = process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

export function extractFromRubyFile(input: RubyExtractInput): FileExtraction {
  const explicitImports = collectRubyRequires(input.tree.rootNode);
  const constantRefs = collectRubyConstantRefs(input.tree.rootNode);
  const fileScope = collectRubyDefinedConstants(input.tree.rootNode);
  const ancestors = collectRubyClassAncestors(input.tree.rootNode);
  const calls = collectRubyCalls(input.tree.rootNode);
  const imports: ImportRef[] = [...explicitImports, ...constantRefs];
  const trackTypes = localTypeTrackingEnabled();
  const yardByLine = trackTypes ? collectYardParamTypes(input.code) : new Map<number, Record<string, string>>();
  const byChunk: ChunkExtraction[] = input.chunks.map((c) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: calls.filter((cr) => cr.startLine >= c.startLine && cr.startLine <= c.endLine),
    };
    if (trackTypes) {
      const bindings = collectLocalBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine, yardByLine);
      if (Object.keys(bindings).length > 0) base.localBindings = bindings;
    }
    return base;
  });
  const out: FileExtraction = {
    relPath: input.relPath,
    language: input.language,
    imports,
    chunks: byChunk,
    fileScope,
  };
  if (ancestors.size > 0) out.classAncestors = ancestors;
  return out;
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
 */
function collectRubyClassAncestors(root: Parser.SyntaxNode): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walkScope = (node: Parser.SyntaxNode, scope: string[]): void => {
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
      const ancestors: string[] = [];
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
              }
              break;
            }
          }
        }
      }
      // Mixins — `include Mod`, `extend Mod`, `prepend Mod` calls inside
      // the class. The `body` field can be undefined when the grammar
      // attaches statements directly under the class node — scan both.
      const body = node.childForFieldName("body");
      const stmtSource = body ? body.children : node.children;
      for (const stmt of stmtSource) {
        const mixin = mixinTargetFromStatement(stmt);
        if (mixin) ancestors.push(mixin);
      }
      if (ancestors.length > 0) out.set(fq, ancestors);
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
  return out;
}

const RUBY_MIXIN_METHODS = new Set(["include", "extend", "prepend"]);

function mixinTargetFromStatement(node: Parser.SyntaxNode): string | null {
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
  return text;
}

/**
 * Collect `varName → typeName` bindings inside the given line range.
 * Sources scanned (in walker-emission order — later writes win):
 *
 *   1. YARD `@param NAME [TYPE]` comments preceding `def NAME(...)`.
 *      Parsed line-by-line from the raw source — tree-sitter-ruby
 *      strips comment text from a normalised form, so we work on raw
 *      input.code via `collectYardParamTypes`.
 *   2. Constructor-call assignments  (`var = ClassName.new(...)`).
 *   3. AR-finder assignments         (`var = Model.find(...)`,
 *      `.first`, `.last`, `.find_by`, `.create`, `.create!`, `.take`).
 *
 * Sources deliberately NOT inferred:
 *   - Bare factory calls (`var = make_user()`) — no class name to attribute.
 *   - Chained Relation tails (`Model.where(...).first`) — `.where` returns
 *     a Relation, we'd need Relation-aware tracking. Bare `Model.first`
 *     IS inferred (the chain root is the Model class itself).
 *   - Tuple / multiple assignment (`a, b = ...`).
 */
function collectLocalBindingsForChunk(
  root: Parser.SyntaxNode,
  startLine: number,
  endLine: number,
  yardByLine: Map<number, Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};

  // YARD `@param` bindings — attach to the def whose line falls in the chunk
  // range. `yardByLine` is keyed by the line of the `def` keyword.
  for (const [line, params] of yardByLine.entries()) {
    if (line < startLine || line > endLine) continue;
    for (const [name, type] of Object.entries(params)) out[name] = type;
  }

  walk(root, (node) => {
    const line = node.startPosition.row + 1;
    if (line < startLine || line > endLine) return;
    if (node.type !== "assignment") return;

    // tree-sitter-ruby `assignment` shape: left/right fields.
    const lhs = node.childForFieldName("left");
    if (lhs?.type !== "identifier") return;
    const varName = lhs.text;
    const rhs = node.childForFieldName("right");
    if (!rhs) return;
    if (rhs.type !== "call" && rhs.type !== "method_call") return;

    const receiver = rhs.childForFieldName("receiver");
    const method = rhs.childForFieldName("method");
    if (!receiver || !method) return;

    // Receiver must look like a class constant (e.g. `User` or `Acme::Auth`).
    const receiverText = receiver.type === "scope_resolution" ? readScopeResolution(receiver) : receiver.text;
    if (!/^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/.test(receiverText)) return;

    const methodName = method.text;
    // `ClassName.new(...)` is the universal Ruby constructor pattern.
    // AR finders also bind to the Model class.
    if (methodName === "new" || AR_INSTANCE_FINDERS.has(methodName)) {
      out[varName] = receiverText;
    }
  });
  return out;
}

/**
 * Parse YARD `# @param NAME [TYPE]` lines and group them by the line
 * number of the `def NAME(...)` they precede. The grammar is light: any
 * comment line matching the pattern attaches to the NEXT non-comment,
 * non-blank line that starts with `def` (with optional `self.` prefix).
 *
 * YARD also supports `# @return [TYPE]` (not used — we bind params only)
 * and bracket-less types (`# @param x String`) which we don't accept;
 * the bracket form is the dominant convention and the only one Sorbet,
 * Solargraph, and SteepGen treat as canonical.
 */
function collectYardParamTypes(code: string): Map<number, Record<string, string>> {
  const lines = code.split(/\r?\n/);
  const out = new Map<number, Record<string, string>>();
  let pending: Record<string, string> | null = null;
  const yardRegex = /^\s*#\s*@param\s+(\w+)\s+\[([\w:]+)\]/;
  const defRegex = /^\s*def\s+(?:self\.)?(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const yardMatch = yardRegex.exec(raw);
    if (yardMatch) {
      const [, name, type] = yardMatch;
      if (!pending) pending = {};
      // SAFETY: regex capture groups (\w+) and ([\w:]+) are non-optional —
      // a successful match guarantees both name and type are strings.
      pending[name] = type;
      continue;
    }
    // Blank or other comment — preserve pending block.
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    // First non-blank, non-comment line. If it's a `def`, attach.
    if (pending && defRegex.test(raw)) {
      out.set(i + 1, pending);
    }
    pending = null;
  }
  return out;
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

/**
 * Methods that are dynamic-dispatch wrappers — when the first argument
 * is a LITERAL symbol or string, the call is statically resolvable as
 * if it were a direct method call. `Object#send`, `Object#public_send`,
 * and the historical `__send__` alias all share the same shape.
 */
const RUBY_DYNAMIC_DISPATCH = new Set(["send", "public_send", "__send__"]);

function collectRubyCalls(root: Parser.SyntaxNode): CallRef[] {
  const out: CallRef[] = [];
  walk(root, (node) => {
    if (node.type !== "call" && node.type !== "method_call") return;
    const receiver = node.childForFieldName("receiver");
    const method = node.childForFieldName("method");
    if (!method) return;
    const startLine = node.startPosition.row + 1;
    const receiverText = receiver
      ? receiver.type === "scope_resolution"
        ? readScopeResolution(receiver)
        : receiver.text
      : null;

    // Dynamic dispatch unwrap: `obj.send(:save)` / `obj.public_send("save")`
    // — when the first arg is a literal symbol/string, the call is
    // semantically a direct method call. Emit it as such; the resolver
    // doesn't need to know send was involved.
    if (RUBY_DYNAMIC_DISPATCH.has(method.text) && receiverText !== null) {
      const unwrapped = extractLiteralSymbolOrString(node);
      if (unwrapped !== null) {
        out.push({ callText: node.text, receiver: receiverText, member: unwrapped, startLine });
        // Note: we deliberately DROP the literal `send` edge — emitting
        // both would double-count fan-out for the same logical call.
        return;
      }
    }

    if (receiverText !== null) {
      out.push({ callText: node.text, receiver: receiverText, member: method.text, startLine });
    } else {
      out.push({ callText: node.text, receiver: null, member: method.text, startLine });
    }

    // Block-pass shorthand: `users.each(&:save)` — &:save desugars to
    // `{ |u| u.save }`. The block-passed method is an additional call
    // edge with no static receiver (the iterator's element type is
    // out of scope here; the resolver falls back to short-name lookup).
    const blockMember = extractBlockPassMethod(node);
    if (blockMember !== null) {
      out.push({ callText: `&:${blockMember}`, receiver: null, member: blockMember, startLine });
    }
  });
  return out;
}

/**
 * Pull the literal symbol or string text out of the first positional
 * argument of a `call` node. Returns the stripped name (`:save` → `save`,
 * `"save"` → `save`) or `null` when the argument is a variable,
 * expression, or absent.
 */
function extractLiteralSymbolOrString(callNode: Parser.SyntaxNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  if (firstArg.type === "simple_symbol") {
    return firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  }
  if (firstArg.type === "string" || firstArg.type === "string_literal") {
    const inner = firstArg.namedChildren.find((c) => c.type === "string_content");
    return inner ? inner.text : firstArg.text.replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Detect `&:method_name` block argument and return the bare method
 * name. tree-sitter-ruby exposes block-pass args as a `block_argument`
 * node whose only child is the proc value — for symbol-to-proc that's
 * a `simple_symbol`. Returns `null` for any other block shape
 * (`&proc_var`, `&Method.method(:foo)`, full `do ... end` block).
 */
function extractBlockPassMethod(callNode: Parser.SyntaxNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type !== "block_argument") continue;
    const child = arg.namedChildren[0];
    if (!child) continue;
    if (child.type === "simple_symbol") {
      return child.text.startsWith(":") ? child.text.slice(1) : child.text;
    }
  }
  return null;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
