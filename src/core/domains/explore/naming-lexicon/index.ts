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
export { splitNameSlots } from "./name-slots.js";
export type { NameSlots } from "./name-slots.js";
export {
  NAMING_VERB_PREFIXES,
  calleeDerivedName,
  calleeDerivedWords,
  classifyNamingShape,
  isNonConceptType,
  isWeakerNamingShape,
  matchesTypeWords,
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
export { alignHead, alignQualifiers, establishedModifiers, modifierLift } from "./term-alignment.js";
export type { ModifierUse, TermAlternative } from "./term-alignment.js";
export { extractConceptTerms } from "./terms.js";
export type { ConceptTerm, ConceptTermHolder } from "./terms.js";
export { TYPE_ROLE_THRESHOLDS, deriveTypeRoles, expectedRoleFor } from "./type-roles.js";
export type { TypeNameRow, TypeRoleAssignment, TypeRoleEvidence, TypeRoleThresholds } from "./type-roles.js";
export { judgeDraftName } from "./verdicts.js";
export type {
  DraftNameJudgementInput,
  NamingByCalleeRow,
  NamingByTypeRow,
  NamingReturnVerbShare,
  NamingVerdict,
} from "./verdicts.js";
