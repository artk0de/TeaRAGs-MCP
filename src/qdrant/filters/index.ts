/**
 * Qdrant filters module
 *
 * Provides client-side filtering utilities for Qdrant search results
 * when native Qdrant filters don't support the required functionality.
 */

export {
  createGlobMatcher,
  filterResultsByGlob,
  calculateFetchLimit,
  type ResultWithPath,
} from "./glob.js";
