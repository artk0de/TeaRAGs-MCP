/**
 * Language kernel — the language-agnostic substrate every per-language vertical
 * (walker, resolver chain, capability descriptor) builds on. A leaf: kernel
 * files import only `contracts/` and `infra/`, never a language vertical.
 *
 * Consumers outside `kernel/` import through this barrel. Kernel files import
 * their siblings directly, never through here — routing a sibling through the
 * barrel would close an import cycle.
 */

export {
  createAncestorLinearizer,
  findMemberInAncestorChain,
  type AncestorClosure,
  type AncestorLinearizationPolicy,
  type AncestorLinearizer,
  type AncestorMemberScan,
  type LinearizedAncestors,
} from "./ancestor-walk.js";
export { assignCallsToInnermostChunks, type ChunkRange } from "./assign-calls-to-chunks.js";
export { fileEdgesFromResolvedCalls } from "./call-derived-file-edges.js";
export { SHARED_LANGUAGE, sharedChunkSetBumpScopes, sharedVersions } from "./capability.js";
export { collectSymbols } from "./collect-symbols.js";
export { ConeDispatchResolver } from "./cone-dispatch.js";
export {
  BARE_GLOBAL_CALLABLES,
  ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS,
  ECMASCRIPT_BUILTIN_TYPES,
  ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS,
  ECMASCRIPT_GLOBALS,
} from "./ecmascript-globals.js";
export {
  ECMASCRIPT_SOURCE_EXTENSIONS,
  isEcmascriptSourcePath,
  lookupEcmascriptSymbols,
  lookupEcmascriptSymbolsByShortName,
  withEcmascriptSymbolKindRoles,
} from "./ecmascript-symbol-lookup.js";
export { ExternalCallClassifier } from "./external-classifier.js";
export {
  declaredVisibilityFacetPass,
  type DeclaredVisibility,
  type DeclaredVisibilityReader,
  type DeclaredVisibilityReading,
} from "./declared-visibility-pass.js";
export {
  typeAbstractnessFacetPass,
  type TypeAbstractnessReader,
  type TypeAbstractnessVerdict,
} from "./type-abstractness-pass.js";
export { buildDispatchCascade, type DispatchCascadeOptions } from "./dispatch-cascade.js";
export {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  EXPLICIT_RECEIVER_VISIBILITY_ACCESS,
  EnclosingClassPrivateAccess,
  KwargNarrower,
  LiteralReceiverNarrower,
  VisibilityNarrower,
  resolveNarrowedFanout,
  type DispatchCandidateNarrower,
  type NarrowedFanoutOptions,
  type VisibilityAccessPolicy,
} from "./dispatch-narrowing.js";
export {
  composeExtractionWalker,
  runExtractionPasses,
  toWalkContext,
  type ExtractionFacetPass,
  type ExtractionWalkerParts,
} from "./extraction-passes.js";
export {
  DISPATCH_FANOUT_CAP_FLOOR,
  DISPATCH_FANOUT_POPULATION_MIN_MEMBERS,
  buildDispatchFanoutPolicy,
  dispatchFanoutPolicyFor,
} from "./fanout-policy.js";
export { symbolLookupOptionsFor, type CallRoleSymbolLookupOptions } from "./symbol-kind-roles.js";
export {
  boundCalleeFromCallShape,
  combineTypeMultiplicity,
  createIdentifierDeclarationFacetPass,
  elementOfCollection,
  fieldRule,
  innermostChunkSymbolId,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationField,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "./identifier-declarations.js";
export { importFileEdge, resolveImportFileEdges } from "./import-file-edges.js";
export { mergeExtraction, type ExtractionChannelMerger, type ExtractionMergeRulebook } from "./merge-extraction.js";
export { methodKindFromClassify } from "./method-kind.js";
export { conventionClassNameFor, type NamingConventionPorts } from "./naming-convention.js";
export {
  CHAIN_MAX_HOPS_DEFAULT,
  callArgumentText,
  propagateReceiverType,
  splitAtBracketDepthZero,
  splitReceiverHops,
  stripCallArgs,
  type ReceiverTypePorts,
} from "./receiver-type-propagation.js";
export { reexportOriginFile } from "./reexport-origin.js";
export { resolveDispatchViaComponents, resolveViaChain } from "./resolver-chain.js";
export { inferReturnTypeName, type ReturnInferencePorts } from "./return-inference.js";
export { DETACHED_RESOLVE_RUN_SCOPE, RunScopedMemo } from "./run-scoped-memo.js";
export { deriveStructuralConformance } from "./structural-conformance.js";
export { DefaultSymbolIdComposer, symbolIdNames } from "./symbol-id.js";
export { produceTestScopeChunks } from "./test-scope-chunks.js";
export { typeFactChannels } from "./type-fact-channels.js";
export { TypeFactStore } from "./type-fact-store.js";
export {
  type InlineTypeSource,
  type ProjectTypeSourceContext,
  type SidecarTypeSource,
  type TypeFact,
} from "./type-facts.js";
export { NIL_TYPE_REF, typeRefEquals, typeRefNonNilArms, typeRefReceiverForm, typeRefUnionOf } from "./type-ref.js";
