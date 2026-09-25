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
export { isTypeFamilyRoleName, mergeUnqualifiedTypeSpellings } from "./homonyms.js";
export type { HomonymTypeCount, HomonymTypeShape } from "./homonyms.js";
export {
  NAMING_VERB_PREFIXES,
  calleeDerivedName,
  calleeDerivedWords,
  classifyNamingShape,
  isNonConceptType,
  isWeakerNamingShape,
  matchesTypeWords,
  shapeDistribution,
} from "./shapes.js";
export type {
  NamingShape,
  NamingShapeContext,
  NamingShapeDistribution,
  NamingShapeInput,
  NamingShapeRow,
  NamingShapeShare,
} from "./shapes.js";
export { extractConceptTerms } from "./terms.js";
export type { ConceptTerm, ConceptTermHolder } from "./terms.js";
export { judgeDraftName } from "./verdicts.js";
export type {
  DraftNameJudgementInput,
  NamingByCalleeRow,
  NamingByTypeRow,
  NamingReturnVerbShare,
  NamingVerdict,
} from "./verdicts.js";
