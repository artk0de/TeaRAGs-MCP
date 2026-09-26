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
 *
 * The flat-Records walk also collects the file's `TypeDeclarationFact`s — one
 * per class, module and constant assignment (bd tea-rags-mcp-vi0wx, spec §1b) —
 * because it already holds the namespace stack, the superclass and every mixin
 * those facts carry. They are naming data only: the Ruby resolver never reads
 * them.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type {
  FileExtraction,
  InheritanceEdgeDecl,
  TypeDeclarationFact,
} from "../../../../contracts/types/codegraph.js";
import { attachedBlockOf, lexicalScopeFqName, readScopeResolution } from "./ast-utils.js";
import { CONSTANT_ASSIGNMENT_NODE_TYPES, symbolKindOf } from "./symbol-kind.js";

/**
 * Flatten a class/module body into every statement that DECLARES FOR IT — the
 * direct statements, plus the ones nested where `self` still resolves to this
 * declaration. Both collectors below read the same flattened list, so a heritage
 * form one of them recognises is a form the other recognises too.
 *
 * Two kinds of nesting are pulled up, in source order, so ordinals and the flat
 * ancestor list stay in declaration order:
 *
 *   - `class << self` (singleton_class) — a mixin inside it contributes to the
 *     enclosing class's ancestor chain (bd tea-rags-mcp-08tss).
 *   - a block attached to a SELF-SCOPED class-body call — `included do … end`,
 *     `concerning :X do … end`, `class_eval do … end` on implicit self. A Ruby
 *     block keeps the `self` of the code that wrote it, so `include Mod` inside
 *     `included do … end` really does mix into the enclosing module, and that
 *     block is the ActiveSupport::Concern idiom (bd tea-rags-mcp-uetqq).
 *
 * A receiver-ful call is NOT descended: `Helper.class_eval do include Bar end`
 * re-points `self` at Helper, so the mixin is Helper's, not ours. An explicit
 * `self` receiver still counts as ours, matching the class-body-form guard in
 * `collectRubyAssociationTypes`.
 */
function classBodyStatements(stmts: readonly AstNode[]): AstNode[] {
  const out: AstNode[] = [];
  const visit = (list: readonly AstNode[]): void => {
    for (const stmt of list) {
      out.push(stmt);
      if (stmt.type === "singleton_class") {
        const singBody = stmt.childForFieldName("body");
        visit(singBody ? singBody.children : stmt.children);
        continue;
      }
      if (stmt.type !== "call" && stmt.type !== "method_call") continue;
      const receiver = stmt.childForFieldName("receiver");
      if (receiver && receiver.type !== "self") continue; // block belongs to another object
      const block = attachedBlockOf(stmt);
      if (!block) continue;
      const blockBody = block.childForFieldName("body");
      visit(blockBody ? blockBody.children : block.children);
    }
  };
  visit(stmts);
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
      for (const stmt of classBodyStatements(stmtSource)) {
        const mixin = mixinTargetFromStatement(stmt);
        if (mixin) edges.push({ source: fq, ancestor: mixin.name, kind: mixin.kind, ordinal: ordinals[mixin.kind]++ });
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
 *
 * `typeDeclarations` is the same walk's per-declaration view (bd
 * tea-rags-mcp-vi0wx, W3c), in source order:
 *
 *   - a `class` / `module` → its lexical FQ, `conforms` = the superclass, then
 *     the modules it `include`s / `prepend`s in source order. `extend Mod` mixes
 *     into the singleton class, not the instances' ancestor chain, so it stays
 *     out. Every declaration is the file's own (`reopens: false`): a file cannot
 *     tell a Ruby class body that re-opens a class from the one that creates it.
 *   - a constant assignment (`MAX = 3`, `Foo::BAR = 3`, `::ROOT = 3`,
 *     `VERSION ||= "1.0"`, and every constant target of `A, *REST = …`,
 *     nested destructuring included) at file, class or module level → the
 *     constant's FQ under the enclosing namespace (`::ROOT` is root-anchored),
 *     on the target's own line. Inside a method body, or a `class << self`
 *     whose constants belong to the singleton class, nothing is emitted.
 *
 * `visitNode`, when given, is offered every node the walk passes — everything
 * but a named declaration's header (name, superclass) and its body wrapper —
 * so a per-node collector shares this traversal instead of running its own.
 */
export interface RubyClassDeclarations {
  ancestors: Map<string, string[]>;
  prepended: Map<string, string[]>;
  superclasses: Map<string, string>;
  compact: Set<string>;
  schemaTables: Map<string, string>;
  typeDeclarations: TypeDeclarationFact[];
}

/** Node types whose body is not a constant scope of the enclosing namespace. */
const CONSTANT_OPAQUE_NODE_TYPES = new Set(["method", "singleton_method", "singleton_class"]);

/** A constant target as written — `MAX`, `Foo::BAR`, `::ROOT` — as opposed to a local, ivar or `obj::X`. */
const CONSTANT_TARGET_RE = /^(?:::)?[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/** Target lists of a multiple assignment: `A, B = …`, a nested `(P, q), …` and a splat `*REST`. */
const TARGET_LIST_NODE_TYPES = new Set(["left_assignment_list", "destructured_left_assignment", "rest_assignment"]);

/** Every single target an assignment's left side names, multiple-assignment lists flattened in source order. */
function assignmentTargets(left: AstNode): AstNode[] {
  if (!TARGET_LIST_NODE_TYPES.has(left.type)) return [left];
  return left.namedChildren.flatMap(assignmentTargets);
}

/** The FQ a single assignment target declares under `scope`, or null when it is not a constant. */
function constantTargetId(target: AstNode, scope: readonly string[]): string | null {
  if (target.type !== "constant" && target.type !== "scope_resolution") return null;
  const text = target.text.replace(/\s+/g, "");
  if (!CONSTANT_TARGET_RE.test(text)) return null;
  return text.startsWith("::") ? text.slice(2) : lexicalScopeFqName(scope, text);
}

/** One `constant` fact per constant target of a (plain, multiple or `||=`-style) assignment. */
function constantDeclarationFacts(node: AstNode, scope: readonly string[]): TypeDeclarationFact[] {
  const symbolKind = symbolKindOf(node.type, { declaresMethod: false, assignsConstant: true });
  const left = node.childForFieldName("left");
  if (symbolKind === undefined || !left) return [];
  const facts: TypeDeclarationFact[] = [];
  for (const target of assignmentTargets(left)) {
    const typeId = constantTargetId(target, scope);
    if (typeId !== null) facts.push({ typeId, symbolKind, line: target.startPosition.row + 1, reopens: false });
  }
  return facts;
}

function classDeclarationFact(node: AstNode, typeId: string, conforms: readonly string[]): TypeDeclarationFact | null {
  const symbolKind = symbolKindOf(node.type, { declaresMethod: false, assignsConstant: false });
  if (symbolKind === undefined) return null;
  const fact: TypeDeclarationFact = { typeId, symbolKind, line: node.startPosition.row + 1, reopens: false };
  return conforms.length > 0 ? { ...fact, conforms } : fact;
}

export function collectRubyClassAncestors(root: AstNode, visitNode?: (node: AstNode) => void): RubyClassDeclarations {
  const typeDeclarations: TypeDeclarationFact[] = [];
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
  // `constantScope` is false below a method body or a `class << self`, where an
  // assignment does not declare a constant of the enclosing namespace.
  const walkScope = (node: AstNode, scope: string[], constantScope: boolean): void => {
    visitNode?.(node);
    if (node.type === "class" || node.type === "module") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) {
        for (const child of node.children) walkScope(child, scope, constantScope);
        return;
      }
      const localName = nameNode.type === "scope_resolution" ? readScopeResolution(nameNode) : nameNode.text;
      const fq = scope.length === 0 ? localName : `${scope.join("::")}::${localName}`;
      if (nameNode.type === "scope_resolution") compactOut.add(fq); // compact `class A::B::C`
      const ancestors: string[] = [];
      const prepended: string[] = [];
      // The type-declaration fact's supertypes: superclass, then include /
      // prepend in source order — never `extend` (see the docblock).
      const conforms: string[] = [];
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
                conforms.push(supText);
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
      // `class << self` bodies and self-scoped class-body blocks
      // (`included do … end`) are pulled up by `classBodyStatements`, so what
      // they declare lands on THIS class (bd tea-rags-mcp-08tss / uetqq).
      const body = node.childForFieldName("body");
      const stmtSource = classBodyStatements(body ? body.children : node.children);
      for (const stmt of stmtSource) {
        const mixin = mixinTargetFromStatement(stmt);
        if (!mixin) continue;
        if (mixin.kind === "prepend") prepended.push(mixin.name);
        else ancestors.push(mixin.name);
        if (mixin.kind !== "extend") conforms.push(mixin.name);
      }
      const fact = classDeclarationFact(node, fq, conforms);
      if (fact !== null) typeDeclarations.push(fact);
      if (ancestors.length > 0) out.set(fq, ancestors);
      if (prepended.length > 0) prependedOut.set(fq, prepended);
      // `self.table_name = "companies"` — the explicit ORM table override
      // (bd tea-rags-mcp-8l5fo). Collected on THIS traversal (which already
      // owns the namespace stack that yields `fq`) rather than in a second walk,
      // over the SAME flattened statements as the mixins — so the override is
      // found whether it sits in the body or in an `included do … end`.
      for (const stmt of stmtSource) {
        const table = schemaTableOverrideFromStatement(stmt);
        if (table !== null) schemaTablesOut.set(fq, table);
      }
      // Recurse — nested classes get their own ancestor maps. Children of
      // the body are the canonical recursion target; without an explicit
      // body field, fall back to scanning the class node's own children.
      const recurseChildren = body ? body.children : node.children;
      for (const child of recurseChildren) walkScope(child, [...scope, ...localName.split("::")], true);
      return;
    }
    if (constantScope && CONSTANT_ASSIGNMENT_NODE_TYPES.has(node.type)) {
      typeDeclarations.push(...constantDeclarationFacts(node, scope));
    }
    const childConstantScope = constantScope && !CONSTANT_OPAQUE_NODE_TYPES.has(node.type);
    for (const child of node.children) walkScope(child, scope, childConstantScope);
  };
  walkScope(root, [], true);
  return {
    ancestors: out,
    prepended: prependedOut,
    superclasses: superclassOut,
    compact: compactOut,
    schemaTables: schemaTablesOut,
    typeDeclarations,
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

/**
 * Fill the FileExtraction's class-hierarchy channels from this file's
 * declarations: `classAncestors`, `compactDeclaredClasses`, `classSchemaTables`,
 * `classPrependedAncestors`, `classExtends` and `inheritanceEdges`.
 *
 * `declarations` is `collectRubyClassAncestors`'s result, collected by the
 * walker ahead of the chunk pass so that walk also feeds the chunk-kind index;
 * the six channels plus `typeDeclarations` are its only consumers.
 *
 * Each channel is written only when non-empty, and every Map is converted to a
 * plain Record on the way out: the codegraph provider spills FileExtraction to
 * NDJSON, and `JSON.stringify` turns a Map into `{}`, silently losing every
 * entry. Plain objects survive the round-trip intact.
 */
export function attachRubyClassHierarchyChannels(
  out: FileExtraction,
  root: AstNode,
  declarations: RubyClassDeclarations,
): void {
  const {
    ancestors: ancestorMap,
    prepended: prependedMap,
    superclasses: superclassMap,
    compact: compactClassSet,
    schemaTables: schemaTableMap,
    typeDeclarations,
  } = declarations;
  if (ancestorMap.size > 0) {
    const ancestorRecord: Record<string, readonly string[]> = createIdentifierRecord();
    for (const [k, v] of ancestorMap) ancestorRecord[k] = v;
    out.classAncestors = ancestorRecord;
  }
  if (compactClassSet.size > 0) out.compactDeclaredClasses = [...compactClassSet];
  if (schemaTableMap.size > 0) {
    const schemaTableRecord: Record<string, string> = createIdentifierRecord();
    for (const [k, v] of schemaTableMap) schemaTableRecord[k] = v;
    out.classSchemaTables = schemaTableRecord;
  }
  if (prependedMap.size > 0) {
    const prependedRecord: Record<string, readonly string[]> = createIdentifierRecord();
    for (const [k, v] of prependedMap) prependedRecord[k] = v;
    out.classPrependedAncestors = prependedRecord;
  }
  // `classExtends` is the cross-language SUPERCLASS channel (JS/TS/Java
  // `extends`), so only `class Foo < Bar` feeds it. Ruby's `extend Mod` mixin
  // is a different declaration and already rode out in `classAncestors` above.
  if (superclassMap.size > 0) {
    const superclassRecord: Record<string, string> = createIdentifierRecord();
    for (const [k, v] of superclassMap) superclassRecord[k] = v;
    out.classExtends = superclassRecord;
  }
  // Unified hierarchy edges with precise kinds (bd tea-rags-mcp-lz8t). Parity
  // with the TS walker's `collectInheritanceEdges`: where the legacy
  // classAncestors Record flattens superclass + include + extend into one
  // include-tagged list, this distinguishes super / include / extend / prepend
  // for the hierarchy graph. The legacy Records stay (resolver-forward path).
  const inheritanceEdges = collectRubyInheritanceEdges(root);
  if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
  if (typeDeclarations.length > 0) out.typeDeclarations = typeDeclarations;
}
