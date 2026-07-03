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
  AritySignature,
  CallRef,
  ChunkExtraction,
  DispatchRef,
  DispatchTable,
  FileExtraction,
  ImportRef,
  InheritanceEdgeDecl,
  KwargSignature,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import {
  FULL_RUBY_CATALOGUE,
  RUBY_DSL,
  singularizeAssociation,
  type RubyDslCatalogue,
  type RubyDslEmits,
} from "../dsl/index.js";
import { catalogueForGemfile } from "../gemfile.js";
import { lexicalScopeFqName, readScopeResolution, walk } from "./ast-utils.js";
import {
  bindCompoundReceiverChains,
  collectRubyBodyReturnTypes,
  collectRubyIvarFieldTypes,
  collectRubyLocalCallBindingsForChunk,
  localTypeTrackingEnabled,
} from "./local-bindings.js";
import { RubyTypeFactStore } from "./type-fact-store.js";
import { collectRubyInstantiatedTypes } from "./type-sources/ast-inference.js";
import { INLINE_TYPE_SOURCES } from "./type-sources/index.js";
import { YARD_CONST } from "./type-sources/yard.js";

export interface RubyExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
  /**
   * Raw `Gemfile` contents for the run (mirrors `WalkInput.gemfileContent`).
   * Extraction consumers gate DSL grammar on it via `catalogueForGemfile`;
   * undefined → FULL catalogue (bd tea-rags-mcp-adx5p.1b).
   */
  gemfileContent?: string;
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
  // Gem-gated DSL grammar at extraction time (adx5p.1b): compose the catalogue
  // for this project's Gemfile once; the emit + type-source consumers below read
  // its facets. undefined gemfileContent → the FULL catalogue (byte-identical).
  const catalogue = catalogueForGemfile(input.gemfileContent);
  const explicitImports = collectRubyRequires(input.tree.rootNode);
  const constantRefs = collectRubyConstantRefs(input.tree.rootNode);
  const fileScope = collectRubyDefinedConstants(input.tree.rootNode);
  const {
    ancestors: ancestorMap,
    prepended: prependedMap,
    extends: extendsMap,
    compact: compactClassSet,
  } = collectRubyClassAncestors(input.tree.rootNode);
  const dispatchTables = collectRubyDispatchTables(input.tree.rootNode);
  const dispatchTableNames = new Set(Object.keys(dispatchTables));
  const calls = collectRubyCalls(input.tree.rootNode, dispatchTableNames, catalogue);
  const imports: ImportRef[] = [...explicitImports, ...constantRefs];
  const trackTypes = localTypeTrackingEnabled();
  // Gather all inline type facts (YARD + AST) through the source registry and
  // build the store once per file. When tracking is off, an empty store is used
  // so localBindingsForChunk / returnTypeByMethod return empty maps cheaply.
  const facts = trackTypes ? INLINE_TYPE_SOURCES.flatMap((s) => s.extract(input)) : [];
  const store = RubyTypeFactStore.fromFacts(facts);
  // Per-class Rails association map (B1): `class → accessor → modelType`. Drives
  // compound-receiver chain typing (`event.user.agents`) in the binding pass and
  // is surfaced on the FileExtraction so resolvers can read it run-global.
  const associationTypes = trackTypes ? collectRubyAssociationTypes(input.tree.rootNode) : {};
  // Innermost-chunk attribution: assign each call to ONE chunk only —
  // the smallest containing range, ties broken by deeper scope length.
  // Without this guard, a call inside `module A { class B { def m ... } }`
  // lands on all four overlapping chunks (file/module/class/method) and
  // inflates caller-edge counts by the nesting depth (bd tea-rags-mcp-8fnu).
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  // Arity + visibility per method def (bd xlnub Task 2). Keyed by 1-based
  // start line — the same line the chunker assigns to the method's chunk.
  const methodSigs = collectRubyMethodSignatures(input.tree.rootNode);
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const sig = c.startLine !== undefined ? methodSigs.get(c.startLine) : undefined;
    if (sig !== undefined) {
      base.arity = sig.arity;
      base.visibility = sig.visibility;
      if (sig.kwargs !== undefined) base.kwargs = sig.kwargs;
      base.acceptsBlock = sig.acceptsBlock;
    }
    if (trackTypes) {
      // Store provides YARD + AST param/local bindings (position-filtered to chunk).
      const localBindings = store.localBindingsForChunk(c.startLine, c.endLine);
      // Compound-receiver association-chain pass (B1): binds prefixes of dotted
      // chain receivers (`event.user → User`, `event.user.agents → Agent`) using
      // the per-class association map. Runs after the store pass so root-segment
      // types are already established in localBindings before chain resolution.
      if (Object.keys(associationTypes).length > 0) {
        const push = (name: string, type: string, line: number): void => {
          (localBindings[name] ??= []).push({ line, type } as LocalBinding);
        };
        bindCompoundReceiverChains(input.tree.rootNode, c.startLine, c.endLine, associationTypes, localBindings, push);
      }
      if (Object.keys(localBindings).length > 0) base.localBindings = localBindings;
      // `localCallBindings` (var → called method) pairs with the run-global
      // `functionReturnTypes` so the resolver binds `x = recv.meth(); x.member`
      // to `<meth's return type>#member` (cai0 a71lj, same channel as Go).
      const callBindings = collectRubyLocalCallBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine, catalogue);
      if (Object.keys(callBindings).length > 0) base.localCallBindings = callBindings;
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
  if (compactClassSet.size > 0) out.compactDeclaredClasses = [...compactClassSet];
  if (prependedMap.size > 0) {
    const prependedRecord: Record<string, readonly string[]> = {};
    for (const [k, v] of prependedMap) prependedRecord[k] = v;
    out.classPrependedAncestors = prependedRecord;
  }
  if (extendsMap.size > 0) {
    const extendsRecord: Record<string, string> = {};
    for (const [k, v] of extendsMap) extendsRecord[k] = v;
    out.classExtends = extendsRecord;
  }
  // Unified hierarchy edges with precise kinds (bd tea-rags-mcp-lz8t). Parity
  // with the TS walker's `collectInheritanceEdges`: where the legacy
  // classAncestors Record flattens superclass + include + extend into one
  // include-tagged list, this distinguishes super / include / extend / prepend
  // for the hierarchy graph. The legacy Records stay (resolver-forward path).
  const inheritanceEdges = collectRubyInheritanceEdges(input.tree.rootNode);
  if (inheritanceEdges.length > 0) out.inheritanceEdges = inheritanceEdges;
  // `functionReturnTypes` — same channel the Go walker fills. Two sources merged
  // (last-write wins → YARD explicit annotation beats body inference):
  //   1. Body inference: last-expression constructor (`def build; Widget.new; end`).
  //   2. YARD `@return [T]` via the store's return facts (brg9).
  const bodyReturnTypes = trackTypes ? collectRubyBodyReturnTypes(input.tree.rootNode, catalogue) : {};
  const returnTypes = { ...bodyReturnTypes, ...store.returnTypeByMethod() };
  if (Object.keys(returnTypes).length > 0) out.functionReturnTypes = returnTypes;
  // RTA instantiation set (bd tea-rags-mcp-pffv): fq consts this file
  // instantiates (`Klass.new` / factory / finder). Gated on the same
  // type-tracking env as the other inference channels — without local-type
  // tracking the cone engine has no localBindings to fan out anyway. The
  // provider unions these run-global to prune CHA cones to live subtypes.
  const instantiatedTypes = trackTypes ? collectRubyInstantiatedTypes(input.tree.rootNode, catalogue) : [];
  if (instantiatedTypes.length > 0) out.instantiatedTypes = instantiatedTypes;
  if (Object.keys(dispatchTables).length > 0) out.dispatchTables = dispatchTables;
  // `@ivar` receiver types via the universal `classFieldTypes` channel (cai0
  // imass) — same env gate as the other type-inference paths. Ruby is the 5th
  // language to fill this channel (after TS/Java/Python/Rust).
  if (trackTypes) {
    const ivarFieldTypes = collectRubyIvarFieldTypes(input.tree.rootNode, associationTypes, input.code, catalogue);
    if (Object.keys(ivarFieldTypes).length > 0) out.classFieldTypes = ivarFieldTypes;
  }
  // Precise type-source maps for the resolver's PRECISE propagation paths
  // (Increment 1, Task 1.5). `structuredReturnTypes` keys `"<fqClass>#method"` →
  // RubyTypeRef (engine's structured-return path); `ivarTypes` keys
  // `fqClass → "@ivar" → typeName` (engine's precise ivar path). Both derive
  // from the SAME store as the flat `functionReturnTypes` / `classFieldTypes`
  // fallbacks — the precise maps win in the engine, the flat maps stay as
  // fallback. Conditionally set (omit when empty) so files with no annotations
  // don't carry empty objects through the NDJSON spill.
  if (trackTypes) {
    const structuredReturnTypes = store.structuredReturnTypesMap();
    if (Object.keys(structuredReturnTypes).length > 0) out.structuredReturnTypes = structuredReturnTypes;
    const ivarTypes = store.ivarTypesMap();
    if (Object.keys(ivarTypes).length > 0) out.ivarTypes = ivarTypes;
  }
  // Rails association map (B1) — emitted only when at least one class declares an
  // association. Consumed run-global by the codegraph provider (mirrors
  // `classFieldTypes` plumbing) and already used by the binding pass above.
  if (Object.keys(associationTypes).length > 0) out.associationTypes = associationTypes;
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
 */
function collectRubyClassAncestors(root: AstNode): {
  ancestors: Map<string, string[]>;
  prepended: Map<string, string[]>;
  extends: Map<string, string>;
  compact: Set<string>;
} {
  const out = new Map<string, string[]>();
  const prependedOut = new Map<string, string[]>();
  const extendsOut = new Map<string, string>();
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
                extendsOut.set(fq, supText);
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
  return { ancestors: out, prepended: prependedOut, extends: extendsOut, compact: compactOut };
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

// ─────────────────────────────────────────────────────────────────────────────
// Arity + visibility capture (bd xlnub Task 2)
// ─────────────────────────────────────────────────────────────────────────────

const VISIBILITY_KEYWORDS = new Set<string>(["private", "protected", "public"]);

/**
 * Compute the positional arity of a `method` or `singleton_method` node.
 * Counts `identifier` (required positional) and `optional_parameter` children
 * of `method_parameters`; sets `hasSplat` when a `splat_parameter` is present.
 * Kwargs (`keyword_parameter`, `hash_splat_parameter`) and block params are
 * ignored — they don't affect positional arity.
 */
function computeRubyArity(methodNode: AstNode): AritySignature {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return { minRequired: 0, maxPositional: 0, hasSplat: false };
  let minRequired = 0;
  let maxPositional = 0;
  let hasSplat = false;
  for (const child of params.namedChildren) {
    if (child.type === "identifier") {
      minRequired++;
      maxPositional++;
    } else if (child.type === "optional_parameter") {
      maxPositional++;
    } else if (child.type === "splat_parameter") {
      hasSplat = true;
    }
    // keyword_parameter, hash_splat_parameter, block_parameter → ignored
  }
  return { minRequired, maxPositional, hasSplat };
}

/**
 * Compute the keyword-arg signature of a `method` / `singleton_method` node
 * (bd d9o7o). A `keyword_parameter` with NO `value` child (no default) is
 * REQUIRED (`def m(b:)` → must supply `b:`); one WITH a default (`c: 1`) is
 * optional and omitted from `required`. `hasSplat` is set by a
 * `hash_splat_parameter` (`**opts`). Returns `undefined` when the method has no
 * kwargs at all — keeps the payload lean and the narrower a no-op for it.
 */
function computeRubyKwargs(methodNode: AstNode): KwargSignature | undefined {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return undefined;
  const required: string[] = [];
  const optional: string[] = [];
  let hasSplat = false;
  for (const child of params.namedChildren) {
    if (child.type === "keyword_parameter") {
      const nameNode = child.childForFieldName("name") ?? child.namedChildren[0];
      if (!nameNode) continue;
      const name = nameNode.text.replace(/:$/, "");
      // A default value is the `value` field; its absence ⇒ required kwarg,
      // its presence ⇒ optional (defaulted) kwarg. Both go into the declared
      // set the extra-unknown-key narrowing checks against (bd d9o7o).
      if (child.childForFieldName("value") === null) required.push(name);
      else optional.push(name);
    } else if (child.type === "hash_splat_parameter") {
      hasSplat = true;
    }
  }
  if (required.length === 0 && optional.length === 0 && !hasSplat) return undefined;
  return { required, optional, hasSplat };
}

/**
 * Collect the call-site keyword-arg key-set (bd d9o7o). `pair` children of the
 * argument list are kwargs (`b: 2` → key `b`); a `hash_splat_argument`
 * (`**opts`) means unknown runtime keys. Positional args / blocks are ignored.
 */
function computeCallKwargs(callNode: AstNode): { kwargKeys?: string[]; hasKwargSplat?: boolean } {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return {};
  const kwargKeys: string[] = [];
  let hasKwargSplat = false;
  for (const child of args.namedChildren) {
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key") ?? child.namedChildren[0];
      if (keyNode) kwargKeys.push(keyNode.text.replace(/:$/, "").replace(/^:/, ""));
    } else if (child.type === "hash_splat_argument") {
      hasKwargSplat = true;
    }
  }
  const out: { kwargKeys?: string[]; hasKwargSplat?: boolean } = {};
  if (kwargKeys.length > 0) out.kwargKeys = kwargKeys;
  if (hasKwargSplat) out.hasKwargSplat = true;
  return out;
}

/**
 * Whether a `method` / `singleton_method` node accepts a block (bd d9o7o):
 * TRUE if it declares a `block_parameter` (`&blk`) OR its body contains a
 * `yield`. FALSE = proven non-yielder (the BlockNarrower only drops these, and
 * only when other yielders remain). Over-detecting yield (e.g. a `yield` in a
 * nested def) is the SAFE direction — it keeps the candidate.
 */
function computeRubyAcceptsBlock(methodNode: AstNode): boolean {
  const params = methodNode.childForFieldName("parameters");
  if (params?.namedChildren.some((c) => c.type === "block_parameter")) return true;
  const body = methodNode.childForFieldName("body");
  if (!body) return false;
  let yields = false;
  walk(body, (n) => {
    if (n.type === "yield") yields = true;
  });
  return yields;
}

/** Whether a call passes a block (`{ … }` / `do … end`) (bd d9o7o). The block
 *  is a `block` / `do_block` node, either a direct child of the call or inside
 *  its argument list. */
function computeCallPassesBlock(callNode: AstNode): boolean {
  if (callNode.children.some((c) => c.type === "block" || c.type === "do_block")) return true;
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  return args ? args.namedChildren.some((c) => c.type === "block" || c.type === "do_block") : false;
}

/**
 * Walk the AST and collect arity + visibility for every `method` /
 * `singleton_method` definition found inside a class or module body.
 *
 * The map is keyed by the method node's 1-based start line so the caller
 * can look up by `ChunkExtraction.startLine` — the chunker assigns the
 * same line to the method chunk it creates for that node.
 *
 * Visibility state machine per class body (source order):
 *   - bare `private`/`protected`/`public` → switches default for subsequent defs
 *   - `private def foo` (inline form) → marks that specific method only
 *   - `private :foo, :bar` (symbol form) → marks those methods by name
 * Default is `"public"` at the start of each class body.
 */
function collectRubyMethodSignatures(root: AstNode): Map<
  number,
  {
    arity: AritySignature;
    visibility: "public" | "private" | "protected";
    kwargs?: KwargSignature;
    acceptsBlock: boolean;
  }
> {
  type VisMode = "public" | "private" | "protected";
  const out = new Map<
    number,
    { arity: AritySignature; visibility: VisMode; kwargs?: KwargSignature; acceptsBlock: boolean }
  >();

  const processClassBody = (classNode: AstNode): void => {
    const body = classNode.childForFieldName("body");
    // namedChildren skips anonymous tokens (punctuation, `end`, `;`) — all
    // type-guards below match only named node types, so behavior is identical
    // while avoiding spurious iterations over anonymous tokens.
    const stmts = body ? body.namedChildren : classNode.namedChildren;

    // Shared helpers: defined once to avoid duplicating anonymous functions
    // across pass-1 and pass-2 (duplicate arrow functions inflate the uncovered
    // function count and would push global coverage below threshold).
    const methodFieldOf = (node: AstNode) =>
      node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
    const argsOf = (node: AstNode) =>
      node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");

    let currentVis: VisMode = "public";
    // symbol-form overrides: method short-name → forced visibility.
    // Pass 1 populates this for ALL symbol-form declarations at THIS body level
    // before pass 2 emits any method defs. Resolves the backward `private :foo`
    // pattern where `def foo` precedes `private :foo` in source order.
    const symVis = new Map<string, VisMode>();

    // Pass 1: collect symbol-form visibility declarations at THIS body level only.
    // Nested class/module bodies are skipped — each gets its own recursive call
    // with its own symVis. Bare switches and inline-def forms are pass-2 only.
    for (const stmt of stmts) {
      if (stmt.type === "class" || stmt.type === "module") continue;
      if (stmt.type === "call" || stmt.type === "method_call") {
        if (stmt.childForFieldName("receiver")) continue;
        const methodField = methodFieldOf(stmt);
        if (!methodField || !VISIBILITY_KEYWORDS.has(methodField.text)) continue;
        const modifier = methodField.text as VisMode;
        const args = argsOf(stmt);
        if (!args || args.namedChildren.length === 0) continue; // bare switch — pass 2
        const firstArg = args.namedChildren[0];
        if (firstArg.type === "method" || firstArg.type === "singleton_method") continue; // inline — pass 2
        // Symbol form: `private :foo, :bar`
        for (const arg of args.namedChildren) {
          if (arg.type === "simple_symbol" || arg.type === "symbol") {
            symVis.set(arg.text.replace(/^:/, ""), modifier);
          }
        }
      }
    }

    // Pass 2: walk in source order — recurse nested classes, apply bare switches,
    // emit inline-def forms, emit method defs (symVis now fully populated).
    for (const stmt of stmts) {
      // Nested class/module — recurse with fresh public default
      if (stmt.type === "class" || stmt.type === "module") {
        processClassBody(stmt);
        continue;
      }

      // Method definition — record arity + current visibility.
      // Precedence: symVis (symbol-form) > currentVis (bare-switch).
      // Inline-modifier form never reaches this branch (it is a child of its
      // call node and emitted in the call handler below).
      if (stmt.type === "method" || stmt.type === "singleton_method") {
        const nameNode = stmt.childForFieldName("name");
        const name = nameNode?.text ?? "";
        out.set(stmt.startPosition.row + 1, {
          arity: computeRubyArity(stmt),
          visibility: symVis.get(name) ?? currentVis,
          kwargs: computeRubyKwargs(stmt),
          acceptsBlock: computeRubyAcceptsBlock(stmt),
        });
        continue;
      }

      // Visibility modifier call: `private`, `private def foo`, `private :foo`
      if (stmt.type === "call" || stmt.type === "method_call") {
        if (stmt.childForFieldName("receiver")) continue; // not a bare class-body call
        const methodField = methodFieldOf(stmt);
        if (!methodField || !VISIBILITY_KEYWORDS.has(methodField.text)) continue;
        const modifier = methodField.text as VisMode;
        const args = argsOf(stmt);
        if (!args || args.namedChildren.length === 0) {
          // Bare visibility switch: `private` with no args
          currentVis = modifier;
        } else {
          const firstArg = args.namedChildren[0];
          if (firstArg.type === "method" || firstArg.type === "singleton_method") {
            // Inline form: `private def foo; end`
            out.set(firstArg.startPosition.row + 1, {
              arity: computeRubyArity(firstArg),
              visibility: modifier,
              kwargs: computeRubyKwargs(firstArg),
              acceptsBlock: computeRubyAcceptsBlock(firstArg),
            });
          }
          // Symbol form already resolved in pass 1 — nothing to do here.
        }
        continue;
      }

      // Bare `private` as identifier node (tree-sitter-ruby may produce this form)
      if (stmt.type === "identifier" && VISIBILITY_KEYWORDS.has(stmt.text)) {
        currentVis = stmt.text as VisMode;
        continue;
      }
    }
  };

  // Top-level walk: descend into nodes looking for class/module declarations.
  // When we find one, processClassBody handles it and its nested classes —
  // so we do NOT recurse further into it from this outer walk (avoids double-visit).
  const walkTopLevel = (node: AstNode): void => {
    if (node.type === "class" || node.type === "module") {
      processClassBody(node);
      return; // processClassBody recurses into nested classes
    }
    for (const child of node.children) walkTopLevel(child);
  };

  walkTopLevel(root);
  return out;
}

/**
 * Count positional arguments at a call site, excluding block arguments
 * (`block`, `do_block`) and keyword arguments (`pair`). No `argument_list`
 * child → 0.
 */
function computeArgCount(callNode: AstNode): number {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return 0;
  return args.namedChildren.filter((c) => c.type !== "block" && c.type !== "do_block" && c.type !== "pair").length;
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
export const RUBY_ASSOCIATION_MACROS = new Set(["has_many", "has_one", "belongs_to", "has_and_belongs_to_many"]);

/**
 * Whether a DSL macro name is a callback registration (duzy). A
 * `before_action :auth` / `after_save :touch` callback names an instance
 * method by symbol; the walker emits a bare-receiver CallRef to it so the
 * resolver's same-class fallback pins `#auth`. Sourced from the single
 * `ruby/dsl` catalogue by `category === "callback"` — adding a callback
 * keyword there automatically enrols it here, no second list to maintain.
 * Exported as the callback-membership oracle for the `emits` parity test —
 * `emits === "self-instance"` ⟺ `isRubyCallbackMacro` (walker-emits.test.ts).
 */
export function isRubyCallbackMacro(name: string): boolean {
  return RUBY_DSL[name]?.category === "callback";
}

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
    const direct = callbackNameFromArg(arg);
    if (direct !== null) {
      out.push(direct);
      continue;
    }
    // `before_action [:a, :b]` — an array literal names one callback per element.
    if (arg.type === "array") {
      for (const el of arg.namedChildren) {
        const name = callbackNameFromArg(el);
        if (name !== null) out.push(name);
      }
      continue;
    }
    // A guard kwarg pair (`only:` / `if:`), proc/lambda, or any other arg ends
    // the leading run of callback-method names.
    break;
  }
  return out;
}

/** Method name a callback positional arg names: `:sym` or `"str"`; `null` otherwise. */
function callbackNameFromArg(arg: AstNode): string | null {
  if (arg.type === "simple_symbol") {
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    return base.length > 0 ? base : null;
  }
  if (arg.type === "string" || arg.type === "string_literal") {
    const inner = arg.namedChildren.find((c) => c.type === "string_content");
    const text = inner ? inner.text : arg.text.replace(/^["']|["']$/g, "");
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Emit the synthetic class-body macro edge(s) for a `receiverText === null`
 * class-body macro call, selected by the macro entry's declarative `emits`
 * descriptor (dsl/types.ts). Replaces the four former per-category `if`
 * branches in {@link collectRubyCalls} — each arm is lifted VERBATIM from the
 * branch it supersedes (reusing the same `extract*` / `associationModelConstant`
 * helpers), so the pushed `{receiver, member}` shapes, the per-shape skip
 * guards, and the push order are byte-identical. `node` is the `call` /
 * `method_call` AST node; `out` accumulates the file's CallRefs.
 *
 * Membership parity (proven in walker-emits.test.ts): a macro entry carries
 *   - `"alias-redirect"`     iff `redirectTarget === "second-symbol"` (alias_method)
 *   - `"delegate-target"`    iff the keyword is `delegate`
 *   - `"self-instance"`      iff `category === "callback"` (isRubyCallbackMacro)
 *   - `"model-constant-ref"` iff the keyword is in RUBY_ASSOCIATION_MACROS
 * so routing dispatch through `emits` fires for the exact same name set as the
 * four predicates did.
 */
function emitDslEdges(node: AstNode, emits: RubyDslEmits, startLine: number, out: CallRef[]): void {
  switch (emits) {
    // `alias_method :new, :old` — old name → {receiver:null, member:old} (bd tea-rags-mcp-y2z5).
    case "alias-redirect": {
      const oldName = extractSecondLiteralSymbol(node);
      if (oldName !== null) {
        out.push({ callText: node.text, receiver: null, member: oldName, startLine });
      }
      return;
    }
    // `delegate :a, :b, to: :recv` — per delegated sym → {receiver:to, member:sym} (bd tea-rags-mcp-mx9z).
    case "delegate-target": {
      const recv = extractDelegateTarget(node);
      if (recv !== null) {
        for (const sym of extractDelegateSymbols(node)) {
          out.push({ callText: node.text, receiver: recv, member: sym, startLine });
        }
      }
      return;
    }
    // `before_action :auth` callbacks — per leading symbol → {receiver:null, member:sym} (duzy).
    // `attributes :id, :name` (AMS serializer) — each attribute is READ off the
    // serialized resource; identical bare-receiver shape to a callback self-send,
    // so it resolves onto the serializer's custom attribute method when one is
    // defined and is honestly unresolved for a pass-through attribute (adx5p.9).
    case "serialized-attribute":
    case "self-instance": {
      for (const sym of extractCallbackSymbols(node)) {
        out.push({ callText: node.text, receiver: null, member: sym, startLine });
      }
      return;
    }
    // `authorize :relay, :update?` — Pundit policy dispatch → {receiver:<Record>Policy, member:<query>?} (n2kpz).
    case "policy-dispatch": {
      const target = punditPolicyTarget(node);
      if (target !== null) {
        out.push({ callText: node.text, receiver: target.policy, member: target.method, startLine });
      }
      return;
    }
    // `get "x", to: "posts#index"` — routed action → {receiver:<Ns::>Controller, member:action} (n2kpz).
    case "route-action": {
      const target = routeActionTarget(node);
      if (target !== null) {
        out.push({ callText: node.text, receiver: target.controller, member: target.action, startLine });
      }
      return;
    }
    // `has_many :posts` associations — model constant → {receiver:C, member:C} (duzy).
    case "model-constant-ref": {
      const model = associationModelConstant(node);
      if (model !== null) {
        out.push({ callText: node.text, receiver: model, member: model, startLine });
      }
    }
  }
}

/**
 * `alias new old` keyword form (bd tea-rags-mcp-y2z5). The new alias method
 * delegates to the old one — emit a synthetic CallRef from the alias chunk to
 * the old method so the call graph traces the redirect. Receiver is null
 * because both methods live on the same class; the resolver's bare-call
 * same-class fallback uses callerScope (= the enclosing class) to pin the
 * target. No-ops for any non-`alias` node.
 */
function emitAliasKeywordEdge(node: AstNode, out: CallRef[], catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE): void {
  if (node.type !== "alias" || catalogue.entries.alias?.redirectTarget !== "alias-keyword-old") return;
  const idents = node.children.filter((c) => c.type === "identifier");
  const oldName = idents[1]?.text;
  if (oldName) {
    out.push({ callText: node.text, receiver: null, member: oldName, startLine: node.startPosition.row + 1 });
  }
}

/**
 * Registry constant-reference edges (bd tea-rags-mcp-ki9v). A constant
 * assignment whose RHS is a collection literal — `CONST = { k => Klass }` or
 * `CONST = [Klass, ...]`, optionally `.freeze`d — hard-references each value
 * class. Those references are `constant`/`scope_resolution` nodes, not `call`
 * nodes, so without this branch the registry chunk gets chunk fanOut=0 despite
 * coupling to every value class. Emit a synthetic reference CallRef per literal
 * constant; receiver === member === the fully-qualified constant so the
 * `constant` resolver pins it to the declaring file as a file-only edge.
 * Constants nested in a lambda / proc / block body (STI-style `-> { Klass }`
 * registries) are deliberately skipped (bd tea-rags-mcp-jw9n). No-ops for any
 * non-`assignment` node.
 */
function emitRegistryConstantRefs(node: AstNode, out: CallRef[]): void {
  if (node.type !== "assignment") return;
  const left = node.childForFieldName("left");
  if (left && (left.type === "constant" || left.type === "scope_resolution")) {
    const literal = unwrapTrailingCalls(node.childForFieldName("right"));
    if (literal && (literal.type === "array" || literal.type === "hash")) {
      collectRegistryConstantValueRefs(literal, out);
    }
  }
}

/**
 * Bare-identifier method calls (bd tea-rags-mcp-hbie). Ruby allows `foo` as
 * shorthand for `foo()` when `foo` is a method, so the walker emits a CallRef
 * for `identifier` nodes in a call-position role. Gated on: a call-position
 * parent (not a binding-introducing field — `isBareIdentifierCallSite`), the
 * name NOT being a local binding of the enclosing method, and being inside a
 * method body (`enclosingMethod !== null`). The resolver's existing safeguards
 * (jsa0 + lttd + t5iw + pl7k) filter residual ambiguity at edge-resolution time.
 */
function emitBareIdentifierCall(
  node: AstNode,
  enclosingMethod: string | null,
  localBindings: Set<string>,
  out: CallRef[],
): void {
  if (
    node.type === "identifier" &&
    enclosingMethod !== null &&
    isBareIdentifierCallSite(node) &&
    !localBindings.has(node.text)
  ) {
    out.push({ callText: node.text, receiver: null, member: node.text, startLine: node.startPosition.row + 1 });
  }
}

/**
 * Bare `super` (no args) parses as a leaf `super` node. The wrapped form
 * `super(...)` / `super(...) { ... }` parses as a `call` whose `method` field
 * is the `super` leaf — that case is handled in the call branch. Both shapes
 * emit identical CallRefs except for `callText` (literal source). No-ops unless
 * this is a bare `super` leaf inside a method body.
 */
function emitBareSuperEdge(node: AstNode, enclosingMethod: string | null, out: CallRef[]): void {
  if (node.type === "super" && node.parent?.type !== "call" && enclosingMethod !== null) {
    out.push({
      callText: node.text,
      receiver: SUPER_RECEIVER_SENTINEL,
      member: enclosingMethod,
      startLine: node.startPosition.row + 1,
    });
  }
}

/**
 * Dynamic-dispatch unwrap classification (bd tea-rags-mcp-8ss5 / cai0). For a
 * `send` / `public_send` call whose first arg is a literal symbol/string, push
 * the unwrapped direct-call CallRef — receiver normalised to null for a bare or
 * `self` receiver so the resolver's same-class fallback takes over — and return
 * `"unwrapped"`; the caller then DROPS the literal `send` edge and recurses (so
 * fan-out is not double-counted). A non-literal first arg returns `"dynamic"`
 * (the literal `send` edge is kept but tagged `dynamicSend`, bd cai0). A
 * non-dispatch method returns `"plain"`. The recurse-into-children + early
 * return stay in the caller so the walk control flow is unchanged.
 */
function emitDynamicSendUnwrap(
  node: AstNode,
  receiver: AstNode | null,
  receiverText: string | null,
  method: AstNode,
  startLine: number,
  out: CallRef[],
): "unwrapped" | "dynamic" | "plain" {
  if (!RUBY_DYNAMIC_DISPATCH.has(method.text)) return "plain";
  const unwrapped = extractLiteralSymbolOrString(node);
  if (unwrapped !== null) {
    const unwrappedReceiver = receiverText === null || receiver?.type === "self" ? null : receiverText;
    out.push({ callText: node.text, receiver: unwrappedReceiver, member: unwrapped, startLine });
    return "unwrapped";
  }
  return "dynamic";
}

/**
 * Emit the macro/method's own literal CallRef (the call edge the source line
 * actually writes). Tags `dynamicSend` for an unresolvable `send(var)` (bd
 * cai0) and attaches a registry-literal `dispatch` when the OUTER `.member`
 * call of a `CONST[k].new.m` chain carries a resolved `field` (bd
 * tea-rags-mcp-pq02v; the inner `.new` returns `field: null` and is skipped, no
 * double tag). Lifted verbatim from the inline call-branch tail.
 */
function emitMethodCallRef(
  node: AstNode,
  receiverText: string | null,
  method: AstNode,
  dynamicSend: boolean,
  dispatchTableNames: ReadonlySet<string>,
  out: CallRef[],
): void {
  const startLine = node.startPosition.row + 1;
  const callRef: CallRef = { callText: node.text, receiver: receiverText, member: method.text, startLine };
  if (dynamicSend) callRef.dynamicSend = true;
  const dispatch = exprToRubyDispatchRef(node, dispatchTableNames);
  if (dispatch?.field) callRef.dispatch = dispatch;
  // Positional argCount (bd xlnub): excludes block and keyword args
  callRef.argCount = computeArgCount(node);
  // Keyword-arg key-set + double-splat (bd d9o7o).
  const kw = computeCallKwargs(node);
  if (kw.kwargKeys !== undefined) callRef.kwargKeys = kw.kwargKeys;
  if (kw.hasKwargSplat !== undefined) callRef.hasKwargSplat = kw.hasKwargSplat;
  // Block presence (bd d9o7o) — only set when true (undefined = no block).
  if (computeCallPassesBlock(node)) callRef.passesBlock = true;
  out.push(callRef);
}

/**
 * Block-pass shorthand: `users.each(&:save)` — `&:save` desugars to
 * `{ |u| u.save }`. The block-passed method is an additional call edge with no
 * static receiver (the iterator's element type is out of scope here; the
 * resolver falls back to short-name lookup). No-ops when the call carries no
 * symbol-to-proc block argument.
 */
function emitBlockPassEdge(node: AstNode, out: CallRef[]): void {
  const blockMember = extractBlockPassMethod(node);
  if (blockMember !== null) {
    out.push({
      callText: `&:${blockMember}`,
      receiver: null,
      member: blockMember,
      startLine: node.startPosition.row + 1,
    });
  }
}

function collectRubyCalls(
  root: AstNode,
  dispatchTableNames: ReadonlySet<string>,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): CallRef[] {
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

    // Synthetic non-call edges this node may carry, independent of the
    // call/method_call branch below. Each helper no-ops unless the node matches
    // its shape — alias-keyword redirect (y2z5), registry constant literal
    // (ki9v), bare-identifier call (hbie), bare `super` leaf (brp1). Lifted
    // verbatim from the former inline blocks; emit order is unchanged.
    emitAliasKeywordEdge(node, out, catalogue);
    emitRegistryConstantRefs(node, out);
    emitBareIdentifierCall(node, enclosingMethod, localBindings, out);
    emitBareSuperEdge(node, enclosingMethod, out);

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

      // Dynamic dispatch unwrap (bd tea-rags-mcp-8ss5 / cai0): `obj.send(:save)`
      // / `public_send("save")` / bare or `self.send(:save)`.
      // emitDynamicSendUnwrap pushes the unwrapped direct-call edge (receiver
      // normalised to null for bare / `self`) and classifies the call. The
      // recurse-into-args + early return for the unwrapped case stay HERE so the
      // literal `send` edge is dropped (no double fan-out for one logical call).
      const sendKind = emitDynamicSendUnwrap(node, receiver, receiverText, method, startLine, out);
      if (sendKind === "unwrapped") {
        for (const child of node.children) visit(child, nextEnclosing, nextBindings);
        return;
      }
      const dynamicSend = sendKind === "dynamic";

      // Synthetic class-body macro edges (bd tea-rags-mcp-y2z5 alias_method /
      // mx9z delegate / duzy callbacks + associations). Each class-body macro
      // family — alias_method redirect, delegate target, callback self-instance,
      // association model-constant — declares which synthetic edge shape it
      // emits via its `emits` descriptor (dsl/types.ts); emitDslEdges builds the
      // shape. This replaces four `if (receiverText === null && <predicate>)`
      // branches with one descriptor-driven dispatch (membership parity proven
      // in walker-emits.test.ts). Only the class-body form fires —
      // `obj.before_action` is a normal method call with a non-null receiver.
      // NO early return: falls through to the literal `callRef` push below, so
      // the synthetic edge(s) precede the macro's own call edge (as before).
      if (receiverText === null) {
        const emits = catalogue.entries[method.text]?.emits;
        if (emits) emitDslEdges(node, emits, startLine, out);
      }

      // The macro/method's own literal call edge, plus the block-pass `&:sym`
      // edge if present. Both lifted verbatim into emit helpers.
      emitMethodCallRef(node, receiverText, method, dynamicSend, dispatchTableNames, out);
      emitBlockPassEdge(node, out);
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
function collectMethodLocalBindings(methodNode: AstNode): Set<string> {
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
 * Pundit `authorize(record, query?)` → the `<Policy>#<method>` its runtime
 * dispatch targets (bd tea-rags-mcp-n2kpz). The policy constant comes from the
 * FIRST arg — a symbol `:relay` → `RelayPolicy`, an array `[:admin, :status]` →
 * `Admin::StatusPolicy` (leading symbols are the namespace, the last is the
 * record). The method comes from the SECOND (query) symbol, normalised to end
 * in `?` (`:update` / `:update?` → `update?`). Returns null for the `@ivar`
 * record form (needs receiver-type inference) or an implicit query (needs the
 * enclosing action name) — both deferred; a null emits no edge.
 */
function punditPolicyTarget(callNode: AstNode): { policy: string; method: string } | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const first = args.namedChildren[0];
  if (!first) return null;
  const stripColon = (t: string): string => (t.startsWith(":") ? t.slice(1) : t);
  let policy: string;
  if (first.type === "simple_symbol") {
    policy = `${camelizeModelName(stripColon(first.text))}Policy`;
  } else if (first.type === "array") {
    const syms = first.namedChildren.filter((c) => c.type === "simple_symbol").map((c) => stripColon(c.text));
    if (syms.length === 0) return null;
    const record = syms[syms.length - 1];
    const namespace = syms.slice(0, -1).map(camelizeModelName);
    policy = [...namespace, `${camelizeModelName(record)}Policy`].join("::");
  } else {
    return null; // @ivar / expression record — receiver-type inference deferred
  }
  const second = args.namedChildren[1];
  if (second?.type !== "simple_symbol") return null; // implicit query (action name) deferred
  const method = stripColon(second.text);
  return { policy, method: method.endsWith("?") ? method : `${method}?` };
}

/** Literal text of a `string` / `string_literal` node with the quotes stripped. */
function stringLiteralText(node: AstNode): string {
  const inner = node.namedChildren.find((c) => c.type === "string_content");
  return inner ? inner.text : node.text.replace(/^["']|["']$/g, "");
}

/**
 * Rails routing `get "/x", to: "posts#index"` / `root "home#index"` → the
 * `<Controller>#<action>` the route dispatches to (bd tea-rags-mcp-n2kpz). The
 * target is the `"c#a"` spec: from the `to:` pair, or the first string arg for
 * `root`. The controller path self-encodes the namespace as `/` segments
 * (`admin/settings#show` → `Admin::SettingsController#show`), so each segment is
 * camelized and joined with `::` before the `Controller` suffix. Returns null
 * when there is no `"c#a"` string (a `to:`-less route, or a `to:` pointing at a
 * rack app / lambda) — nothing to emit.
 */
function routeActionTarget(callNode: AstNode): { controller: string; action: string } | null {
  const args = callNode.childForFieldName("arguments") ?? callNode.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  let spec: string | null = null;
  for (const arg of args.namedChildren) {
    if (arg.type === "pair" && arg.childForFieldName("key")?.text === "to") {
      const value = arg.childForFieldName("value");
      if (value && (value.type === "string" || value.type === "string_literal")) spec = stringLiteralText(value);
    }
  }
  if (spec === null) {
    const first = args.namedChildren[0];
    if (first && (first.type === "string" || first.type === "string_literal")) spec = stringLiteralText(first);
  }
  if (!spec?.includes("#")) return null;
  const hash = spec.indexOf("#");
  const ctrlPath = spec.slice(0, hash);
  const action = spec.slice(hash + 1);
  if (ctrlPath.length === 0 || action.length === 0) return null;
  const controller = `${ctrlPath.split("/").map(camelizeModelName).join("::")}Controller`;
  return { controller, action };
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
