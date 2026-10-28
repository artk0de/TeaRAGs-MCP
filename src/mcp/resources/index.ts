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
  renderGuideTemplate,
  FILTERS_DOC_WRITTEN_BUT_UNDECLARED_KEYS,
  META_ONLY_CONTRACT,
} from "./registry.js";

export { AGENT_CONTEXT_CORE } from "./generated/agent-context.js";
export {
  CORE_RESOURCE_URI,
  INSTRUCTIONS_MAX_CHARS,
  serverInstructions,
  type ServerInstructionsMode,
} from "./instructions.js";
export { formatAgentDigest, formatFullDigest } from "./project/digest.js";
