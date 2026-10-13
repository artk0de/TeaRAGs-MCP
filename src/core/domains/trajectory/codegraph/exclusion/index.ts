/**
 * Codegraph exclusion barrel.
 *
 * A leaf component below the codegraph root: the symbols provider builds its
 * file filter and collects the language capabilities from here, and the root
 * facade re-exports the public subset, so nothing in here may import a codegraph
 * sibling back (`tests/core/domains/trajectory/codegraph/
 * codegraph-import-direction.test.ts` pins the symbols side).
 */

export {
  buildCodegraphExclusionFilter,
  CODEGRAPH_GENERATED_PATTERNS,
  collectInstantiationSiteResolvers,
  collectKnownTargetCalleeLocators,
  collectSchemaColumnSources,
  collectStructuralConformanceDerivers,
} from "./exclusion.js";
export type { CodegraphExclusionOptions } from "./exclusion.js";
