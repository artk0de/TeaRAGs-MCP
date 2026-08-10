/**
 * Publishes the type-inference channels of a Ruby `FileExtraction`.
 *
 * Everything the resolver learns about TYPES from one file leaves through here:
 * `functionReturnTypes`, `instantiatedTypes`, `classFieldTypes`,
 * `knownTargetCallArgs`, `classFieldParamLinks`, `structuredReturnTypes`,
 * `ivarTypes` and `associationTypes`. Some come straight off the file type env,
 * some need one more AST pass, and two are MERGES whose precedence is the point
 * (see the comments below) — grouping them puts every precedence decision in one
 * readable place instead of scattering it down an assembly tail.
 *
 * Every channel is conditional: a file with no annotations must not carry empty
 * objects through the codegraph provider's NDJSON spill.
 *
 * The whole set is behind the same `enabled` gate as the env itself. With type
 * tracking off, this attaches nothing.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../../contracts/types/codegraph.js";
import type { RubyDslCatalogue } from "../dsl/index.js";
import type { RubyFileTypeEnv } from "./file-type-env.js";
import { collectRubyBodyReturnTypes, collectRubyScopedBodyReturnTypes } from "./local-bindings.js";
import {
  collectKnownTargetCallArgs,
  collectRubyClassFieldParamLinks,
  type KnownTargetCallSite,
} from "./param-arg-types.js";
import { collectRubyInstantiatedTypes } from "./type-sources/ast-inference.js";

export function attachRubyTypeChannels(
  out: FileExtraction,
  root: AstNode,
  typeEnv: RubyFileTypeEnv,
  siteContextAt: (line: number) => KnownTargetCallSite,
  catalogue: RubyDslCatalogue,
): void {
  const { enabled: trackTypes, store, associationTypes, ivarFieldTypes } = typeEnv;
  // `functionReturnTypes` — same channel the Go walker fills. Two sources merged
  // (last-write wins → YARD explicit annotation beats body inference):
  //   1. Body inference: last-expression constructor (`def build; Widget.new; end`).
  //   2. YARD `@return [T]` via the store's return facts (brg9).
  const bodyReturnTypes = trackTypes ? collectRubyBodyReturnTypes(root, catalogue) : {};
  const returnTypes = { ...bodyReturnTypes, ...store.returnTypeByMethod() };
  if (Object.keys(returnTypes).length > 0) out.functionReturnTypes = returnTypes;
  // RTA instantiation set (bd tea-rags-mcp-pffv): fq consts this file
  // instantiates (`Klass.new` / factory / finder). Gated on the same
  // type-tracking env as the other inference channels — without local-type
  // tracking the cone engine has no localBindings to fan out anyway. The
  // provider unions these run-global to prune CHA cones to live subtypes.
  const instantiatedTypes = trackTypes ? collectRubyInstantiatedTypes(root, catalogue) : [];
  if (instantiatedTypes.length > 0) out.instantiatedTypes = instantiatedTypes;
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
    const knownTargetCallArgs = collectKnownTargetCallArgs(root, siteContextAt, catalogue);
    if (knownTargetCallArgs.length > 0) out.knownTargetCallArgs = knownTargetCallArgs;
    const classFieldParamLinks = collectRubyClassFieldParamLinks(root);
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
    for (const [key, ref] of Object.entries(collectRubyScopedBodyReturnTypes(root, catalogue))) {
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
}
