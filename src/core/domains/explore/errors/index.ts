/**
 * Explore error vocabulary barrel.
 *
 * The error vocabulary is a leaf component below the explore root: the root
 * facade, `strategies/`, `queries/` and `working-tree/dense-floor.ts` all
 * consume it, so nothing in here may import an explore root file back
 * (`tests/core/domains/explore/explore-import-direction.test.ts` pins that).
 * Files inside `explore/` import this barrel; consumers outside the domain
 * import the full `domains/explore/errors/index.js` path.
 */

export {
  ChunkNotFoundError,
  CollectionNotFoundError,
  EmptyFilterPresetError,
  ExploreError,
  HybridNotEnabledError,
  InvalidQueryError,
  InvalidStrategyError,
  UnknownFilterPresetError,
  WorkingTreeEmbeddingMalformedError,
} from "./explore-errors.js";
export type { ExploreErrorCode } from "./explore-errors.js";
