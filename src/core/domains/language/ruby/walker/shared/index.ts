/**
 * The Ruby walker's shared leaf: the extraction input type, the AST helpers,
 * the body-tail selection and the container vocabularies. Every module here
 * imports only `contracts/`, so the walker root, its type sources and the
 * resolver all depend on this barrel without reaching each other
 * (bd tea-rags-mcp-0qaht.37).
 */
export {
  attachedBlockOf,
  forEachClassScope,
  lexicalScopeFqName,
  readScopeResolution,
  typeConstantName,
  walk,
} from "./ast-utils.js";
export { rubyBodyTailExpression } from "./body-tail.js";
export { CONTAINER_BLOCK_ITERATION_METHODS, CONTAINER_ELEMENT_RETURNING_METHODS } from "./container-vocabulary.js";
export type { RubyExtractInput } from "./extract-input.js";
