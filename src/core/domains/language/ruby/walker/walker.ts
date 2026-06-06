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

import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../contracts/types/codegraph.js";
import { RUBY_DSL } from "../dsl/index.js";

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
 * Sentinel receiver value emitted by the walker for synthetic CallRefs
 * representing the Ruby `super` keyword (bd tea-rags-mcp-brp1). The token
 * begins with `<` — invalid in real Ruby identifiers — so the resolver
 * can branch on it unambiguously without colliding with any actual
 * receiver text. Mirrors the `zeitwerk:` prefix discipline: a single
 * exported constant is the contract between walker and resolver.
 */
export const SUPER_RECEIVER_SENTINEL = "<super>";

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
  const { ancestors: ancestorMap, prepended: prependedMap } = collectRubyClassAncestors(input.tree.rootNode);
  const calls = collectRubyCalls(input.tree.rootNode);
  const imports: ImportRef[] = [...explicitImports, ...constantRefs];
  const trackTypes = localTypeTrackingEnabled();
  const yardByLine = trackTypes ? collectYardParamTypes(input.code) : new Map<number, Record<string, string>>();
  // Innermost-chunk attribution: assign each call to ONE chunk only —
  // the smallest containing range, ties broken by deeper scope length.
  // Without this guard, a call inside `module A { class B { def m ... } }`
  // lands on all four overlapping chunks (file/module/class/method) and
  // inflates caller-edge counts by the nesting depth (bd tea-rags-mcp-8fnu).
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
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
  if (ancestorMap.size > 0) {
    // Convert Map → Record so the field round-trips through the NDJSON
    // spill in the codegraph provider. Map serialises to {} and would
    // lose every entry; plain objects survive JSON.stringify intact.
    const ancestorRecord: Record<string, readonly string[]> = {};
    for (const [k, v] of ancestorMap) ancestorRecord[k] = v;
    out.classAncestors = ancestorRecord;
  }
  if (prependedMap.size > 0) {
    const prependedRecord: Record<string, readonly string[]> = {};
    for (const [k, v] of prependedMap) prependedRecord[k] = v;
    out.classPrependedAncestors = prependedRecord;
  }
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
function collectRubyClassAncestors(root: Parser.SyntaxNode): {
  ancestors: Map<string, string[]>;
  prepended: Map<string, string[]>;
} {
  const out = new Map<string, string[]>();
  const prependedOut = new Map<string, string[]>();
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
      const body = node.childForFieldName("body");
      const stmtSource = body ? body.children : node.children;
      for (const stmt of stmtSource) {
        const mixin = mixinTargetFromStatement(stmt);
        if (!mixin) continue;
        if (mixin.kind === "prepend") prepended.push(mixin.name);
        else ancestors.push(mixin.name);
      }
      if (ancestors.length > 0) out.set(fq, ancestors);
      if (prepended.length > 0) prependedOut.set(fq, prepended);
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
  return { ancestors: out, prepended: prependedOut };
}

const RUBY_MIXIN_METHODS = new Set(["include", "extend", "prepend"]);

function mixinTargetFromStatement(
  node: Parser.SyntaxNode,
): { name: string; kind: "include" | "extend" | "prepend" } | null {
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
 * Strip trailing no-arg call wrappers (`{...}.freeze`, `[...].freeze.dup`) to
 * reach the underlying collection literal. Returns the receiver chain's root,
 * which the caller checks for `array` / `hash`. Non-call inputs pass through.
 */
function unwrapTrailingCalls(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  let n = node;
  while (n?.type === "call") {
    const receiver = n.childForFieldName("receiver");
    if (!receiver) break;
    n = receiver;
  }
  return n;
}

/**
 * Emit a reference CallRef for every constant / scope_resolution used inside a
 * constant-assigned collection literal (registry pattern, bd tea-rags-mcp-ki9v).
 * Mirrors `collectRubyConstantRefs`'s outermost-only discipline for nested
 * `scope_resolution`. Descent stops at lambda / proc / block / nested def
 * bodies: a constant referenced there is dispatched at runtime, not a static
 * registry reference, and is out of scope (bd tea-rags-mcp-jw9n). Receiver and
 * member both carry the fully-qualified constant so the `constant` resolver
 * pins it to the declaring file (file-only edge when no method matches).
 */
function collectRegistryConstantValueRefs(literal: Parser.SyntaxNode, out: CallRef[]): void {
  const walkValue = (n: Parser.SyntaxNode): void => {
    if (
      n.type === "lambda" ||
      n.type === "block" ||
      n.type === "do_block" ||
      n.type === "method" ||
      n.type === "singleton_method"
    ) {
      return;
    }
    if (n.type === "scope_resolution") {
      if (n.parent?.type === "scope_resolution") return; // outermost only
      const qualified = readScopeResolution(n);
      if (qualified) {
        out.push({ callText: qualified, receiver: qualified, member: qualified, startLine: n.startPosition.row + 1 });
      }
      return;
    }
    if (n.type === "constant") {
      if (n.parent?.type === "scope_resolution") return; // covered by the outer chain
      out.push({ callText: n.text, receiver: n.text, member: n.text, startLine: n.startPosition.row + 1 });
      return;
    }
    for (const child of n.children) walkValue(child);
  };
  walkValue(literal);
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

  // Recursive walk that tracks the enclosing instance / singleton method
  // name so `super` emissions can attribute to the correct member without
  // a separate scope pass. `enclosingMethod` is updated on entry into a
  // `method` / `singleton_method` node and reset to null below the def.
  // `localBindings` tracks identifier names introduced by the enclosing
  // method's scope (parameters, assignment LHS, block vars, rescue-vars,
  // for-loop vars) so bare-identifier emission can skip local-var reads
  // (bd tea-rags-mcp-hbie).
  const visit = (node: Parser.SyntaxNode, enclosingMethod: string | null, localBindings: Set<string>): void => {
    let nextEnclosing = enclosingMethod;
    let nextBindings = localBindings;
    if (node.type === "method" || node.type === "singleton_method") {
      // tree-sitter-ruby exposes the method's bare name via the `name`
      // field for both `def foo` and `def self.foo`. Singleton methods
      // additionally carry an `object` field for `self` — we ignore it
      // because Ruby's super dispatches by the method's own name, not by
      // any explicit receiver text.
      const nameNode = node.childForFieldName("name");
      if (nameNode) nextEnclosing = nameNode.text;
      // Fresh local-binding scope per method definition. Parameters of
      // the def itself populate it; nested defs get their own fresh set.
      nextBindings = collectMethodLocalBindings(node);
    }

    // `alias new old` keyword form (bd tea-rags-mcp-y2z5). The new alias
    // method delegates to the old one — emit a synthetic CallRef from the
    // alias chunk to the old method so the call graph traces the
    // redirect. Receiver is null because both methods live on the same
    // class; the resolver's bare-call same-class fallback uses
    // callerScope (= the enclosing class) to pin the target.
    if (node.type === "alias" && RUBY_DSL.alias?.redirectTarget === "alias-keyword-old") {
      const idents = node.children.filter((c) => c.type === "identifier");
      const oldName = idents[1]?.text;
      if (oldName) {
        out.push({
          callText: node.text,
          receiver: null,
          member: oldName,
          startLine: node.startPosition.row + 1,
        });
      }
    }

    // Registry constant-reference edges (bd tea-rags-mcp-ki9v). A constant
    // assignment whose RHS is a collection literal — `CONST = { k => Klass }`
    // or `CONST = [Klass, ...]`, optionally `.freeze`d — hard-references each
    // value class. Those references are `constant`/`scope_resolution` nodes,
    // not `call` nodes, so without this branch the registry chunk gets
    // chunk fanOut=0 despite coupling to every value class. Emit a synthetic
    // reference CallRef per literal constant; receiver === member === the
    // fully-qualified constant so the `constant` resolver pins it to the
    // declaring file as a file-only edge (the method-edge fan-out counts it).
    // Constants nested in a lambda / proc / block body (STI-style
    // `-> { Klass }` registries) are deliberately skipped — those resolve at
    // call time, a separate type-aware concern (bd tea-rags-mcp-jw9n).
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left && (left.type === "constant" || left.type === "scope_resolution")) {
        const literal = unwrapTrailingCalls(node.childForFieldName("right"));
        if (literal && (literal.type === "array" || literal.type === "hash")) {
          collectRegistryConstantValueRefs(literal, out);
        }
      }
    }

    // Bare-identifier method calls (bd tea-rags-mcp-hbie). Ruby allows
    // `foo` as shorthand for `foo()` when `foo` is a method, so the
    // walker must emit a CallRef for `identifier` nodes that sit in a
    // call-position role. We gate on:
    //   - parent is NOT one of the binding-introducing fields (def name,
    //     parameters, assignment.left, element_reference receiver, etc.)
    //   - identifier name is NOT in the enclosing method's local-binding
    //     set (parameter / assignment LHS / block var / rescue var / for var)
    //   - we are inside a method body (enclosingMethod !== null) — top-
    //     level identifiers don't carry a method scope for attribution
    // The resolver's existing safeguards (jsa0 + lttd + t5iw + pl7k)
    // filter the residual ambiguity at edge-resolution time.
    if (
      node.type === "identifier" &&
      enclosingMethod !== null &&
      isBareIdentifierCallSite(node) &&
      !localBindings.has(node.text)
    ) {
      out.push({
        callText: node.text,
        receiver: null,
        member: node.text,
        startLine: node.startPosition.row + 1,
      });
    }

    // Bare `super` (no args) parses as a leaf `super` node. The wrapped
    // form `super(...)` / `super(...) { ... }` parses as a `call` whose
    // first child is the `super` leaf and whose `method` field is null;
    // that case is handled in the `call` branch below. Both shapes emit
    // identical CallRefs except for `callText` (literal source).
    if (node.type === "super" && node.parent?.type !== "call" && enclosingMethod !== null) {
      out.push({
        callText: node.text,
        receiver: SUPER_RECEIVER_SENTINEL,
        member: enclosingMethod,
        startLine: node.startPosition.row + 1,
      });
    }

    if (node.type === "call" || node.type === "method_call") {
      const receiver = node.childForFieldName("receiver");
      const method = node.childForFieldName("method");
      const startLine = node.startPosition.row + 1;

      // `super(args)` / `super { block }` — tree-sitter-ruby parses this
      // as a `call` whose `method` field IS the `super` leaf (not null,
      // as one might expect from the bare-leaf form). Detect by node
      // type so the synthetic CallRef carries the enclosing method's
      // name as `member`, matching the bare-leaf path.
      if (method?.type === "super" && enclosingMethod !== null) {
        out.push({
          callText: node.text,
          receiver: SUPER_RECEIVER_SENTINEL,
          member: enclosingMethod,
          startLine,
        });
        // Continue recursion: args/block children may contain real calls
        // (e.g. `super(Float::INFINITY) { |x| do_thing(x) }`).
        for (const child of node.children) visit(child, nextEnclosing, nextBindings);
        return;
      }

      if (!method) {
        // Defensive: a `call` node with no `method` field that isn't the
        // super-wrapped shape. Recurse so nested calls in args still
        // emit; no own CallRef to push.
        for (const child of node.children) visit(child, nextEnclosing, nextBindings);
        return;
      }

      const receiverText = receiver
        ? receiver.type === "scope_resolution"
          ? readScopeResolution(receiver)
          : receiver.text
        : null;

      // Dynamic dispatch unwrap: `obj.send(:save)` / `obj.public_send("save")`
      // / bare `send(:save)` / `self.send(:save)` — when the first arg is a
      // literal symbol/string, the call is semantically a direct method
      // call. Emit it as such; the resolver doesn't need to know send was
      // involved.
      //
      // Receiver normalisation (bd tea-rags-mcp-8ss5):
      //   - `obj.send(:foo)`    → receiver="obj",  member="foo"
      //   - `self.send(:foo)`   → receiver=null,    member="foo"
      //   - bare `send(:foo)`   → receiver=null,    member="foo"
      // Both bare-receiver and `self`-receiver normalise to null so the
      // resolver's same-class bare-call fallback (callerScope-aware
      // pickSingleCandidate filter) takes over. The receiver-set
      // unknown-type drop guard would otherwise refuse to emit an edge.
      if (RUBY_DYNAMIC_DISPATCH.has(method.text)) {
        const unwrapped = extractLiteralSymbolOrString(node);
        if (unwrapped !== null) {
          const unwrappedReceiver = receiverText === null || receiver?.type === "self" ? null : receiverText;
          out.push({ callText: node.text, receiver: unwrappedReceiver, member: unwrapped, startLine });
          // Recurse into children so nested calls in the args still emit;
          // we deliberately DROP the literal `send` edge — emitting both
          // would double-count fan-out for the same logical call.
          for (const child of node.children) visit(child, nextEnclosing, nextBindings);
          return;
        }
      }

      // `alias_method :new, :old` synthetic call edge (bd tea-rags-mcp-y2z5).
      // Only the class-body form fires — `obj.alias_method` is a normal
      // method call and must not synthesise a redirect.
      if (receiverText === null && RUBY_DSL[method.text]?.redirectTarget === "second-symbol") {
        const oldName = extractSecondLiteralSymbol(node);
        if (oldName !== null) {
          out.push({ callText: node.text, receiver: null, member: oldName, startLine });
          // Continue recursion so nested expressions inside the macro
          // call (rare but possible) still emit; do NOT return early —
          // we still want the literal `alias_method` edge below as the
          // primary call (matches `attr_accessor` / `delegate` pattern).
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
    }

    for (const child of node.children) visit(child, nextEnclosing, nextBindings);
  };

  visit(root, null, new Set<string>());
  return out;
}

/**
 * Whether an `identifier` node sits in a call-position role suitable for
 * bare-identifier method emission. Excludes positions where the identifier
 * is a declaration site (method/parameter name, assignment LHS) or already
 * accounted-for by the `call`/`method_call` emission path (the call's own
 * `method` / `receiver` field). Local-variable READS that look like calls
 * (`prs` after `prs = {}`) are filtered separately via the localBindings
 * set in the parent walker — this guard only filters by syntactic position.
 */
function isBareIdentifierCallSite(id: Parser.SyntaxNode): boolean {
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
function collectMethodLocalBindings(methodNode: Parser.SyntaxNode): Set<string> {
  const out = new Set<string>();
  const walkBindings = (node: Parser.SyntaxNode): void => {
    if (node.type === "method_parameters" || node.type === "block_parameters") {
      for (const child of node.namedChildren) collectParamName(child, out);
    }
    if (node.type === "assignment") {
      const lhs = node.childForFieldName("left");
      if (lhs?.type === "identifier") out.add(lhs.text);
      // `prs[:k] = v` — element_reference LHS doesn't bind a new local
      // (prs was already bound earlier), so no add here. But `a, b = x`
      // tuple assignment isn't handled — out of scope per spec.
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
function collectParamName(node: Parser.SyntaxNode, out: Set<string>): void {
  if (node.type === "identifier") {
    out.add(node.text);
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
 * Pull the SECOND positional argument's literal symbol text out of a
 * call node. Used by `alias_method :new, :old` to recover the old method
 * name (the alias target) so the walker can synthesise a CallRef from
 * the new alias to the old method (bd tea-rags-mcp-y2z5).
 */
function extractSecondLiteralSymbol(callNode: Parser.SyntaxNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const secondArg = args.namedChildren[1];
  if (secondArg?.type !== "simple_symbol") return null;
  return secondArg.text.startsWith(":") ? secondArg.text.slice(1) : secondArg.text;
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

/**
 * Assign each call to exactly ONE chunk — the smallest containing line
 * range. Tie-breaker: deeper scope (longer `scope[]`) wins, so a method-
 * level chunk beats its enclosing class/module when both happen to span
 * the same number of lines.
 *
 * Returns a Map keyed by chunk index → CallRef[]. Chunks with no calls
 * have no entry (caller defaults to `[]`).
 *
 * Calls whose startLine falls outside every chunk are dropped silently —
 * matches the previous behaviour for unreachable call sites.
 */
function assignCallsToInnermostChunks(
  calls: CallRef[],
  chunks: { startLine: number; endLine: number; scope: string[] }[],
): Map<number, CallRef[]> {
  const out = new Map<number, CallRef[]>();
  for (const call of calls) {
    let bestIdx = -1;
    let bestSpan = Number.POSITIVE_INFINITY;
    let bestDepth = -1;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (call.startLine < c.startLine || call.startLine > c.endLine) continue;
      const span = c.endLine - c.startLine;
      const depth = c.scope.length;
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        bestIdx = i;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    if (bestIdx === -1) continue;
    const bucket = out.get(bestIdx);
    if (bucket) bucket.push(call);
    else out.set(bestIdx, [call]);
  }
  return out;
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
