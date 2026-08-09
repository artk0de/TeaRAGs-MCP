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
 *
 * This module is the ORCHESTRATOR: it runs the collection passes in order and
 * assembles their results into one FileExtraction. The passes themselves live
 * in siblings, one per extraction concern:
 *
 *   - `class-hierarchy.ts`     — inheritance edges, ancestors, mixins
 *   - `constant-refs.ts`       — requires, Zeitwerk refs, defined constants
 *   - `method-signatures.ts`   — arity / kwargs / visibility, and the call-site
 *                                shapes the narrowers compare them against
 *   - `registry-dispatch.ts`   — `CONST = {…}.freeze` refs and dispatch tables
 *   - `call-collection.ts`     — the call-site walk and its emit helpers
 *   - `dsl-edge-emitters.ts`   — synthetic edges for Rails/DSL macros
 *   - `association-types.ts`   — the Rails association map
 *   - `bare-call-detection.ts` — is this bare identifier a call, or a local?
 *
 * The names those siblings own but that the resolver imports from HERE are
 * re-exported at the bottom, so `walker.js` stays the one address for them.
 */

import type { MaterializedTree } from "../../../../contracts/types/ast.js";
import type {
  CallRef,
  ChunkExtraction,
  FileExtraction,
  ImportRef,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { catalogueForGemfile } from "../gemfile.js";
import { collectRubyAssociationTypes } from "./association-types.js";
import { collectRubyCalls } from "./call-collection.js";
import { collectRubyClassAncestors, collectRubyInheritanceEdges } from "./class-hierarchy.js";
import { collectRubyConstantRefs, collectRubyDefinedConstants, collectRubyRequires } from "./constant-refs.js";
import {
  bindCompoundReceiverChains,
  collectRubyBodyReturnTypes,
  collectRubyIvarFieldTypes,
  collectRubyLocalCallBindingsForChunk,
  collectRubyScopedBodyReturnTypes,
  localTypeTrackingEnabled,
} from "./local-bindings.js";
import { collectRubyMethodSignatures } from "./method-signatures.js";
import {
  collectKnownTargetCallArgs,
  collectRubyClassFieldParamLinks,
  type KnownTargetCallSite,
} from "./param-arg-types.js";
import { collectRubyDispatchTables } from "./registry-dispatch.js";
import { RubyTypeFactStore } from "./type-fact-store.js";
import { collectRubyInstantiatedTypes } from "./type-sources/ast-inference.js";
import { INLINE_TYPE_SOURCES } from "./type-sources/index.js";

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
    schemaTables: schemaTableMap,
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
  // `@ivar` field types (cai0 imass) — hoisted ABOVE the chunk loop because the
  // known-target arg-hint pass reads them to type an `@ivar` ARGUMENT
  // (bd tea-rags-mcp-bvalc). Pure, so the position of the call is immaterial;
  // it is still surfaced on the extraction below, unchanged.
  const ivarFieldTypes = trackTypes
    ? collectRubyIvarFieldTypes(input.tree.rootNode, associationTypes, input.code, catalogue)
    : {};
  // Per-chunk type environments, in `input.chunks` order, so a known-target call
  // site can be typed against the bindings of the chunk that OWNS its line
  // (bd tea-rags-mcp-bvalc). Filled during the chunk loop, read after it.
  const chunkSites: (KnownTargetCallSite & { startLine: number; endLine: number })[] = [];
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
      // Positional names map a call site's argument INDEX to a parameter NAME at
      // the pass-1→pass-2 barrier (bd tea-rags-mcp-bvalc). Omitted when the
      // leading required run is empty — nothing to map.
      if (sig.paramNames.length > 0) base.paramNames = sig.paramNames;
      base.visibility = sig.visibility;
      if (sig.kwargs !== undefined) base.kwargs = sig.kwargs;
      base.acceptsBlock = sig.acceptsBlock;
      // Only ever set when TRUE — absent means "carries a real body", which is
      // the overwhelming majority of defs (bd tea-rags-mcp-bcdfe).
      if (sig.isAbstractStub) base.isAbstractStub = true;
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
      // Type environment a known-target call site on these lines inherits
      // (bd tea-rags-mcp-bvalc).
      chunkSites.push({
        startLine: c.startLine,
        endLine: c.endLine,
        scope: c.scope,
        localBindings: base.localBindings,
        classFields: ivarFieldTypes[c.scope.join("::")],
      });
    }
    return base;
  });
  // Innermost chunk owning a line — the narrowest containing range, ties broken
  // by deeper scope, mirroring `assignCallsToInnermostChunks`. No chunk contains
  // the line (a top-level statement) ⇒ file scope with no type environment.
  const siteContextAt = (line: number): KnownTargetCallSite => {
    let best: (typeof chunkSites)[number] | undefined;
    for (const site of chunkSites) {
      if (line < site.startLine || line > site.endLine) continue;
      if (
        best === undefined ||
        site.endLine - site.startLine < best.endLine - best.startLine ||
        (site.endLine - site.startLine === best.endLine - best.startLine && site.scope.length > best.scope.length)
      ) {
        best = site;
      }
    }
    return best ?? { scope: [] };
  };
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
  if (schemaTableMap.size > 0) {
    // Record (not Map) so the channel survives the NDJSON spill round-trip.
    const schemaTableRecord: Record<string, string> = {};
    for (const [k, v] of schemaTableMap) schemaTableRecord[k] = v;
    out.classSchemaTables = schemaTableRecord;
  }
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
  if (Object.keys(ivarFieldTypes).length > 0) out.classFieldTypes = ivarFieldTypes;
  // Interprocedural parameter typing, Increment 1 (bd tea-rags-mcp-bvalc). Both
  // channels are HALF-FACTS the pass-1→pass-2 barrier completes: argument types
  // at syntactically-known callees, and `@ivar = <param>` copies whose type is
  // whatever that parameter turns out to hold. Same env gate as every other
  // inference channel.
  if (trackTypes) {
    const knownTargetCallArgs = collectKnownTargetCallArgs(input.tree.rootNode, siteContextAt, catalogue);
    if (knownTargetCallArgs.length > 0) out.knownTargetCallArgs = knownTargetCallArgs;
    const classFieldParamLinks = collectRubyClassFieldParamLinks(input.tree.rootNode);
    if (Object.keys(classFieldParamLinks).length > 0) out.classFieldParamLinks = classFieldParamLinks;
  }
  // Precise type-source maps for the resolver's PRECISE propagation paths
  // (Increment 1, Task 1.5). `structuredReturnTypes` keys `"<fqClass>#method"` →
  // RubyTypeRef (engine's structured-return path); `ivarTypes` keys
  // `fqClass → "@ivar" → typeName` (engine's precise ivar path). Both read the
  // store's DECLARED facts — the flat `functionReturnTypes` / `classFieldTypes`
  // above stay as the inference-based fallback the engine consults second.
  // Conditionally set (omit when empty) so files with no annotations don't carry
  // empty objects through the NDJSON spill.
  //
  // `ivarTypes` is empty on every file today (bd tea-rags-mcp-wr7ku): no source
  // in INLINE_TYPE_SOURCES emits `kind:"ivar"`. Do NOT "fix" that by copying
  // `ivarFieldTypes` in here — that publishes AST inference under the channel
  // that outranks it, and buys nothing (measured on taxdome: no fq class draws
  // ivar types from more than one file, so the run-global merge adds zero).
  // The channel goes live when a Sorbet/RBS source starts emitting ivar facts.
  if (trackTypes) {
    const structuredReturnTypes = store.structuredReturnTypesMap();
    // Owner-qualified body inference (bd tea-rags-mcp-rwv3o) — the same
    // last-expression fact `functionReturnTypes` carries flat, under the
    // declaring class's coordinate so a KNOWN receiver (and a bare self-call
    // narrowed by the caller's class) can apply it without the flat map's
    // corpus-uniqueness gate, plus the memoized-reader tail this channel alone
    // carries (bd tea-rags-mcp-smvyk). Merged only where the store declared
    // nothing, so YARD / associations / the service-entry source keep precedence
    // exactly as `DEFAULT_SOURCE_ORDER` states.
    for (const [key, ref] of Object.entries(collectRubyScopedBodyReturnTypes(input.tree.rootNode, catalogue))) {
      if (!(key in structuredReturnTypes)) structuredReturnTypes[key] = ref;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports — `walker.js` stays the single import address for the resolver,
// the type-sources and the recall-forensics script. The definitions moved to
// the sibling modules named in the header; the surface here is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export {
  associationAccessorName,
  associationModelConstant,
  camelizeModelName,
  collectRubyAssociationTypes,
  RUBY_ASSOCIATION_MACROS,
} from "./association-types.js";
export { SUPER_RECEIVER_SENTINEL } from "./call-collection.js";
export { ZEITWERK_PREFIX } from "./constant-refs.js";
export { isRubyCallbackMacro } from "./dsl-edge-emitters.js";
