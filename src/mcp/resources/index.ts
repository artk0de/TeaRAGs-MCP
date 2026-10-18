/**
 * MCP resources barrel — re-exports public API.
 */

export {
  registerAllResources,
  buildOverview,
  buildPresetsDoc,
  buildSignalsDoc,
  buildSearchGuide,
  buildIndexingGuide,
  buildFiltersDoc,
  buildSignalLabelsGuide,
  FILTERS_DOC_WRITTEN_BUT_UNDECLARED_KEYS,
  META_ONLY_CONTRACT,
} from "./registry.js";
