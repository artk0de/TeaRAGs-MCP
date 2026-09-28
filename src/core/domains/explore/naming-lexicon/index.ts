export {
  detectIdentifierCasing,
  joinIdentifierWords,
  pluralizeIdentifierWord,
  pluralizeIdentifierWords,
  renderIdentifier,
  renderIdentifierPlural,
  singularizeIdentifierWord,
  splitIdentifierWords,
  stripIdentifierDecorations,
  typeNameLastSegment,
  typeNameWords,
} from "./casing.js";
export { judgeGenericNames } from "./generic-names.js";
export type { GenericNameThresholds, JudgedGenericName } from "./generic-names.js";
export { isTypeFamilyRoleName, mergeUnqualifiedTypeSpellings } from "./homonyms.js";
export type { HomonymTypeCount, HomonymTypeShape } from "./homonyms.js";
export { CONNECTOR_WORDS, splitNameSlots, typeNameParts } from "./name-slots.js";
export type { NameSlots, TypeNameParser, TypeNameParts } from "./name-slots.js";
export {
  NAMING_VERB_PREFIXES,
  calleeDerivedName,
  calleeDerivedWords,
  classifyNamingShape,
  isNonConceptType,
  isWeakerNamingShape,
  matchesTypeWords,
  mergedHolders,
  mergedSameTypeSiblingN,
  shapeDistribution,
  spellsTypeName,
} from "./shapes.js";
export type {
  NamingShape,
  NamingShapeContext,
  NamingShapeDistribution,
  NamingShapeInput,
  NamingShapeRow,
  NamingShapeShare,
} from "./shapes.js";
export {
  alignHead,
  alignQualifiers,
  anchoredHeadCandidates,
  correctedSimilarityFloor,
  establishedModifiers,
  MIN_NULL_SAMPLE_HEADS,
  modifierLift,
  NULL_SAMPLE_HEADS,
  NULL_SIMILARITY_QUANTILE,
  nullHeadSample,
  nullSimilarityDistribution,
  pathTerms,
  perComparisonQuantile,
  sharesWordStem,
  similarityQuantile,
} from "./term-alignment.js";
export type { HeadCandidate, ModifierUse, PathTerm, TermAlternative } from "./term-alignment.js";
export { extractConceptTerms } from "./terms.js";
export type { ConceptTerm, ConceptTermHolder } from "./terms.js";
export { typeNameHeadCarriers } from "./type-name-heads.js";
export type { TypeNameHeadCarriers } from "./type-name-heads.js";
export { TYPE_ROLE_THRESHOLDS, deriveTypeRoles, expectedRoleFor, filePrimaryDeclaration } from "./type-roles.js";
export type { TypeNameRow, TypeRoleAssignment, TypeRoleEvidence, TypeRoleThresholds } from "./type-roles.js";
export {
  TYPE_DRAFT_KINDS,
  judgeDraftName,
  judgeTypeDraft,
  singleCarrierHeadFiles,
  typeDraftAlignmentWords,
  typeDraftEvidence,
  typeDraftMeaningPairs,
  typeDraftPopulation,
  typeFamilyMembers,
  typeNameEvidence,
  withFamilyAnalogues,
} from "./verdicts.js";
export type {
  DraftNameJudgementInput,
  NamingExpectedTypeRole,
  NamingPreference,
  TypeDraftJudgementInput,
  TypeDraftPopulation,
  TypeNameEvidence,
  NamingByCalleeRow,
  NamingByTypeRow,
  NamingReturnVerbShare,
  NamingVerdict,
} from "./verdicts.js";
