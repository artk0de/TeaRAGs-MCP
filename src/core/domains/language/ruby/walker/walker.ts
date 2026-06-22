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

import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  ChunkExtraction,
  DispatchRef,
  DispatchTable,
  FileExtraction,
  ImportRef,
  InheritanceEdgeDecl,
} from "../../../../contracts/types/codegraph.js";
import { RUBY_DSL, singularizeAssociation } from "../dsl/index.js";
import { readScopeResolution, walk } from "./ast-utils.js";
import {
  collectLocalBindingsForChunk,
  collectYardParamTypes,
  collectYardReturnTypes,
  localTypeTrackingEnabled,
  YARD_CONST,
} from "./local-bindings.js";

export interface RubyExtractInput {
  tree: MaterializedTree;
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

export function extractFromRubyFile(input: RubyExtractInput): FileExtraction {
  const explicitImports = collectRubyRequires(input.tree.rootNode);
  const constantRefs = collectRubyConstantRefs(input.tree.rootNode);
  const fileScope = collectRubyDefinedConstants(input.tree.rootNode);
  const { ancestors: ancestorMap, prepended: prependedMap } = collectRubyClassAncestors(input.tree.rootNode);
  const dispatchTables = collectRubyDispatchTables(input.tree.rootNode);
  const dispatchTableNames = new Set(Object.keys(dispatchTables));
  const calls = collectRubyCalls(input.tree.rootNode, dispatchTableNames);
  const imports: ImportRef[] = [...explicitImports, ...constantRefs];
  const trackTypes = localTypeTrackingEnabled();
  const yardByLine = trackTypes ? collectYardParamTypes(input.code) : new Map<number, Record<string, string>>();
  const yardReturnTypes = trackTypes ? collectYardReturnTypes(input.code) : {};
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
  // Unified hierarchy edges with precise kinds (bd tea-rags-mcp-lz8t). Parity
  // with the TS walker's `collectInheritanceEdges`: where the legacy
  // classAncestors Record flattens superclass + include + extend into one
  // include-tagged list, this distinguishes super / include / extend / prepend
  // for the hierarchy graph. The legacy Records stay (resolver-forward path).
  const inheritanceEdges = collectRubyInheritanceEdges(input.tree.rootNode);
  if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
  // YARD `@return [T]` return types (brg9) — same channel the Go walker fills
  // (`FileExtraction.functionReturnTypes`). Emitted only when at least one
  // single-constant return annotation was found.
  if (Object.keys(yardReturnTypes).length > 0) out.functionReturnTypes = yardReturnTypes;
  if (Object.keys(dispatchTables).length > 0) out.dispatchTables = dispatchTables;
  return out;
}

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
function collectRubyInheritanceEdges(root: AstNode): InheritanceEdgeDecl[] {
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
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
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
        if (!mixin) continue;
        edges.push({ source: fq, ancestor: mixin.name, kind: mixin.kind, ordinal: ordinals[mixin.kind]++ });
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
 */
function collectRubyClassAncestors(root: AstNode): {
  ancestors: Map<string, string[]>;
  prepended: Map<string, string[]>;
} {
  const out = new Map<string, string[]>();
  const prependedOut = new Map<string, string[]>();
  const walkScope = (node: AstNode, scope: string[]): void => {
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

/**
 * `require 'foo'`, `require_relative './foo'`. Tree-sitter-ruby emits
 * these as `call` nodes with method = "require" / "require_relative"
 * and a string argument.
 */
function collectRubyRequires(root: AstNode): ImportRef[] {
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
function collectRubyConstantRefs(root: AstNode): ImportRef[] {
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
 * Strip trailing no-arg call wrappers (`{...}.freeze`, `[...].freeze.dup`) to
 * reach the underlying collection literal. Returns the receiver chain's root,
 * which the caller checks for `array` / `hash`. Non-call inputs pass through.
 */
function unwrapTrailingCalls(node: AstNode | null): AstNode | null {
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
function collectRegistryConstantValueRefs(literal: AstNode, out: CallRef[]): void {
  const walkValue = (n: AstNode): void => {
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
 * Normalize a Ruby hash key node to the string used in `DispatchTable.entries`
 * keys AND in `DispatchRef.key` (bd tea-rags-mcp-pq02v). String literal → inner
 * text without quotes; symbol (`:k` / `k:` hash-key sugar) → bare name. Returns
 * null for a non-literal / computed key (the entry is then dropped — m46z, never
 * guess a runtime key). Shared by the table build and the call-site key read so
 * both produce identical key strings.
 */
function rubyDispatchKeyText(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "string") {
    const inner = node.namedChildren.find((c) => c.type === "string_content");
    return inner ? inner.text : node.text.replace(/^['"`]|['"`]$/g, "");
  }
  if (node.type === "simple_symbol") return node.text.replace(/^:/, "");
  if (node.type === "hash_key_symbol") return node.text; // `k:` sugar → bare `k`
  return null;
}

/**
 * Extract a class FQ-name from a registry VALUE node (bd tea-rags-mcp-pq02v).
 * `scope_resolution` → full `A::B::C` via readScopeResolution; bare `constant` →
 * its text. Anything else (lambda, call, nested literal) → null (dropped).
 */
function rubyDispatchValueConstant(node: AstNode | null): string | null {
  if (!node) return null;
  if (node.type === "scope_resolution") return readScopeResolution(node) || null;
  if (node.type === "constant") return node.text;
  return null;
}

/**
 * Build the per-constant dispatch tables for registry-literal dispatch
 * (bd tea-rags-mcp-pq02v). Mirrors the TS `collectDispatchTables` shape but for
 * Ruby `CONST = <hash|array>.freeze` assignments. Entry values are class
 * FQ-names (see DispatchTable doc overload). A hash key uses its literal text; an
 * array element uses its positional index. Tables with zero constant-valued
 * entries are omitted. Shares the assignment/literal detection with
 * `collectRegistryConstantValueRefs` (which keeps emitting the chunk-ref edges).
 */
function collectRubyDispatchTables(root: AstNode): Record<string, DispatchTable> {
  const out: Record<string, DispatchTable> = {};
  walk(root, (node) => {
    if (node.type !== "assignment") return;
    const left = node.childForFieldName("left");
    if (!left || (left.type !== "constant" && left.type !== "scope_resolution")) return;
    const name = left.type === "scope_resolution" ? readScopeResolution(left) : left.text;
    const literal = unwrapTrailingCalls(node.childForFieldName("right"));
    if (!literal) return;
    const entries: Record<string, string> = {};
    if (literal.type === "hash") {
      for (const pair of literal.namedChildren) {
        if (pair.type !== "pair") continue;
        const key = rubyDispatchKeyText(pair.childForFieldName("key"));
        const value = rubyDispatchValueConstant(pair.childForFieldName("value"));
        if (key !== null && value !== null) entries[key] = value;
      }
    } else if (literal.type === "array") {
      let i = 0;
      for (const el of literal.namedChildren) {
        const value = rubyDispatchValueConstant(el);
        if (value !== null) entries[String(i)] = value;
        i++;
      }
    } else {
      return;
    }
    if (Object.keys(entries).length > 0) out[name] = { entries };
  });
  return out;
}

/**
 * Abstract-interpret a Ruby callee chain to its dispatch reference
 * (bd tea-rags-mcp-pq02v). Composes through `element_reference` (the table
 * subscript), the `.new` instantiation (pass-through), and the outer `.member`
 * call (the dispatched method). Returns null when the chain is not rooted at a
 * known dispatch-table constant.
 *
 *   CONST            → (not a ref on its own)
 *   CONST[k]         → { table: CONST, field: null, key: staticKeyOf }
 *   CONST[k].new     → same ref, field stays null (Kernel#new pass-through)
 *   CONST[k].new.m   → { table: CONST, field: "m", key }
 */
function exprToRubyDispatchRef(node: AstNode, tableNames: ReadonlySet<string>): DispatchRef | null {
  if (node.type === "element_reference") {
    const obj = node.childForFieldName("object") ?? node.namedChildren[0];
    if (!obj) return null;
    const objName =
      obj.type === "scope_resolution" ? readScopeResolution(obj) : obj.type === "constant" ? obj.text : null;
    if (objName === null || !tableNames.has(objName)) return null;
    // The subscript index is the named child after the object.
    const index = node.namedChildren[1] ?? null;
    return { table: objName, field: null, key: rubyDispatchKeyText(index) };
  }
  if (node.type === "call" || node.type === "method_call") {
    const receiver = node.childForFieldName("receiver");
    const method = node.childForFieldName("method");
    if (!receiver || !method) return null;
    const inner = exprToRubyDispatchRef(receiver, tableNames);
    if (!inner) return null;
    // `.new` on a table-bound chain is a pass-through (instantiation, no edge).
    if (method.text === "new" && inner.field === null) return inner;
    // Outer `.member` on an entry-ref (field still null) → select the member.
    if (inner.field === null) return { table: inner.table, field: method.text, key: inner.key };
  }
  return null;
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
function collectRubyDefinedConstants(root: AstNode): string[] {
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

/**
 * Methods that are dynamic-dispatch wrappers — when the first argument
 * is a LITERAL symbol or string, the call is statically resolvable as
 * if it were a direct method call. `Object#send`, `Object#public_send`,
 * and the historical `__send__` alias all share the same shape.
 */
const RUBY_DYNAMIC_DISPATCH = new Set(["send", "public_send", "__send__"]);

/**
 * AR / controller association macros whose first symbol argument names an
 * associated MODEL (duzy). `has_many :posts` references the `Post` model;
 * the walker emits a constant-ref CallRef to that model so the association
 * declaration carries a file→file edge to the model file (mirrors the
 * registry-constant-ref discipline). Method-accessor synthesis for these
 * (`User#posts` etc.) lives in `name-of.ts` `AR_ASSOCIATION_MACROS`.
 */
const RUBY_ASSOCIATION_MACROS = new Set(["has_many", "has_one", "belongs_to", "has_and_belongs_to_many"]);

/**
 * Whether a DSL macro name is a callback registration (duzy). A
 * `before_action :auth` / `after_save :touch` callback names an instance
 * method by symbol; the walker emits a bare-receiver CallRef to it so the
 * resolver's same-class fallback pins `#auth`. Sourced from the single
 * `ruby/dsl` catalogue by `category === "callback"` — adding a callback
 * keyword there automatically enrols it here, no second list to maintain.
 */
function isRubyCallbackMacro(name: string): boolean {
  return RUBY_DSL[name]?.category === "callback";
}

/**
 * Camelize a snake_case association base into a Ruby class name (duzy):
 * `blog_posts` → `BlogPost`. The caller singularizes first; this only
 * upcases each `_`-separated segment's first char and joins.
 */
function camelizeModelName(snake: string): string {
  return snake
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Resolve the associated model constant for an association macro call
 * (duzy). An explicit `class_name: 'Foo'` / `class_name: "Acme::Bar"`
 * kwarg wins verbatim (the canonical AR override); otherwise the first
 * symbol argument is singularized + camelized by Rails convention. Returns
 * `null` when neither a usable `class_name:` string nor a leading symbol
 * argument is present — no model edge can be synthesised syntactically.
 */
function associationModelConstant(callNode: AstNode): string | null {
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
 * Collect every leading symbol-argument name from a callback macro call
 * (duzy) — `before_action :a, :b, only: :show` → `["a", "b"]`. Stops at the
 * first non-`simple_symbol` arg (the `only:` / `if:` kwarg pair), so guard
 * conditions never become spurious method edges. Mirrors the `delegate`
 * leading-symbol scan in `extractDelegateSymbols`.
 */
function extractCallbackSymbols(callNode: AstNode): string[] {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") break;
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    if (base.length > 0) out.push(base);
  }
  return out;
}

function collectRubyCalls(root: AstNode, dispatchTableNames: ReadonlySet<string>): CallRef[] {
  const out: CallRef[] = [];

  // Recursive walk that tracks the enclosing instance / singleton method
  // name so `super` emissions can attribute to the correct member without
  // a separate scope pass. `enclosingMethod` is updated on entry into a
  // `method` / `singleton_method` node and reset to null below the def.
  // `localBindings` tracks identifier names introduced by the enclosing
  // method's scope (parameters, assignment LHS, block vars, rescue-vars,
  // for-loop vars) so bare-identifier emission can skip local-var reads
  // (bd tea-rags-mcp-hbie).
  const visit = (node: AstNode, enclosingMethod: string | null, localBindings: Set<string>): void => {
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

      // `delegate :a, :b, to: :recv` synthetic call edges (bd tea-rags-mcp-mx9z).
      // ActiveSupport / Forwardable generate forwarder methods whose body calls
      // `recv.sym`. The macro-symbol synthesiser (macros.ts) already emits the
      // forwarder method symbols (#a, #b), but their codegraph chunk had
      // fanOut=0 — the delegation TARGET was unlinked. Emit one CallRef per
      // delegated symbol: receiver = the `to:` value (leading `:` stripped for a
      // symbol literal; a constant stays as-is), member = the delegated symbol.
      // Only the class-body form fires — `obj.delegate` is a normal method call.
      // Syntactic-only: the resolver's same-class bare-call fallback pins a
      // method/attr `to:`, the constant strategy pins a constant `to:`.
      if (receiverText === null && method.text === "delegate") {
        const recv = extractDelegateTarget(node);
        if (recv !== null) {
          for (const sym of extractDelegateSymbols(node)) {
            out.push({ callText: node.text, receiver: recv, member: sym, startLine });
          }
        }
      }

      // `before_action :auth` / callback macros synthetic edges (duzy). A
      // callback registers an instance method by symbol; emit a bare-receiver
      // CallRef per symbol so the resolver's same-class fallback (callerScope =
      // the enclosing controller / model) pins `#auth`. Only the class-body
      // form fires — `obj.before_action` is a normal method call. Leading
      // symbols only: `only:` / `if:` guard kwargs never become edges.
      if (receiverText === null && isRubyCallbackMacro(method.text)) {
        for (const sym of extractCallbackSymbols(node)) {
          out.push({ callText: node.text, receiver: null, member: sym, startLine });
        }
      }

      // `has_many :posts` / `belongs_to :y` association model edge (duzy). The
      // association references the associated MODEL class; emit a constant-ref
      // CallRef (receiver === member === the FQ constant) so the constant
      // resolver pins it to the model's declaring file as a file→file edge —
      // identical discipline to `collectRegistryConstantValueRefs`. The
      // accessor methods (`User#posts` etc.) are synthesised separately in
      // name-of.ts. Only the class-body form fires.
      if (receiverText === null && RUBY_ASSOCIATION_MACROS.has(method.text)) {
        const model = associationModelConstant(node);
        if (model !== null) {
          out.push({ callText: node.text, receiver: model, member: model, startLine });
        }
      }

      const callRef: CallRef = { callText: node.text, receiver: receiverText, member: method.text, startLine };
      // Registry-literal dispatch tagging (bd tea-rags-mcp-pq02v). Only the
      // OUTER `.member` call of a `CONST[k].new.m` chain yields a ref with
      // `field` set; the inner `.new` node returns `field: null` and is skipped
      // (no double tag). The `element_reference` node is not a call → never here.
      const dispatch = exprToRubyDispatchRef(node, dispatchTableNames);
      if (dispatch?.field) callRef.dispatch = dispatch;
      out.push(callRef);

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
function isBareIdentifierCallSite(id: AstNode): boolean {
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
function collectMethodLocalBindings(methodNode: AstNode): Set<string> {
  const out = new Set<string>();
  const walkBindings = (node: AstNode): void => {
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
function collectParamName(node: AstNode, out: Set<string>): void {
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
function extractLiteralSymbolOrString(callNode: AstNode): string | null {
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
function extractSecondLiteralSymbol(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const secondArg = args.namedChildren[1];
  if (secondArg?.type !== "simple_symbol") return null;
  return secondArg.text.startsWith(":") ? secondArg.text.slice(1) : secondArg.text;
}

/**
 * Collect the leading delegated symbol names from a `delegate :a, :b, to: :recv`
 * call — every `simple_symbol` argument UNTIL the first non-symbol (the `to:`
 * pair, other kwargs like `allow_nil:` / `prefix:`). Mirrors the delegate loop
 * in `macro-expansion.ts` so the synthesised CallRefs line up 1:1 with the
 * codegraph's synthesised forwarder method symbols (bd tea-rags-mcp-mx9z).
 */
function extractDelegateSymbols(callNode: AstNode): string[] {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") break;
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    if (base.length > 0) out.push(base);
  }
  return out;
}

/**
 * Pull the `to:` receiver text from a `delegate ..., to: <value>` call. The
 * value is the right side of the `to:` pair: a symbol literal (`:client` →
 * `client`, leading `:` stripped) for a method/attr target, or a constant
 * (`SomeConst`, returned verbatim) the resolver's constant strategy pins.
 * Returns `null` when no `to:` pair is present or its value is neither a
 * symbol nor a constant (e.g. a runtime expression) — no edge can be
 * synthesised syntactically (bd tea-rags-mcp-mx9z).
 */
function extractDelegateTarget(callNode: AstNode): string | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (arg.type !== "pair") continue;
    const key = arg.childForFieldName("key");
    if (key?.text !== "to") continue;
    const value = arg.childForFieldName("value");
    if (!value) return null;
    if (value.type === "simple_symbol") {
      return value.text.startsWith(":") ? value.text.slice(1) : value.text;
    }
    if (value.type === "constant") return value.text;
    if (value.type === "scope_resolution") return readScopeResolution(value);
    return null;
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
function extractBlockPassMethod(callNode: AstNode): string | null {
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
