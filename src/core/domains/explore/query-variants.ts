/**
 * Query variants (bd tea-rags-mcp-2vuz): semantic_search / hybrid_search take
 * several phrasings of one intent in ONE call — `query` as an array, or a
 * string holding {@link QUERY_VARIANT_SEPARATOR}. Both spellings reduce to the
 * same variant list here; two or more variants are embedded in one batch and
 * searched as one RRF-fused Qdrant request.
 */

import { MAX_QUERY_VARIANTS, QUERY_VARIANT_SEPARATOR } from "../../contracts/types/query-variants.js";
import { InvalidQueryError } from "./errors/index.js";
import type { WorkingTreeView } from "./working-tree/overlay.js";

export { MAX_QUERY_VARIANTS, QUERY_VARIANT_SEPARATOR };

/** One variant of the request's query, with its dense vector once embedded. */
export interface ExploreQueryVariant {
  query: string;
  embedding?: number[];
}

/**
 * The request's query as its variant list. A string without the separator is
 * returned verbatim — the single-query path is unchanged; otherwise every part
 * is trimmed and empty parts are dropped.
 */
export function splitQueryVariants(query: string | readonly string[]): string[] {
  if (typeof query === "string" && !query.includes(QUERY_VARIANT_SEPARATOR)) return [query];
  const parts = typeof query === "string" ? [query] : query;
  const variants = parts
    .flatMap((part) => part.split(QUERY_VARIANT_SEPARATOR))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (variants.length === 0) throw new InvalidQueryError("every query variant is empty");
  if (variants.length > MAX_QUERY_VARIANTS) {
    throw new InvalidQueryError(
      `${variants.length} query variants, at most ${MAX_QUERY_VARIANTS} are fused`,
      `Pass at most ${MAX_QUERY_VARIANTS} phrasings (\`a ||| b\`); merge or drop the rest`,
    );
  }
  return variants;
}

/**
 * The working-tree view a variant request reads: the same view without the
 * floor readers. The dense and sparse floors score the tree's rows against ONE
 * query; with several fused legs there is no such query, so the touched files'
 * base rows stay in the answer flagged with `treeState` — the answer every
 * floor gives when the view cannot supply its rows. The marker is the view's
 * own object, so what the request records still reaches the response.
 */
export function withoutWorkingTreeFloors(view: WorkingTreeView): WorkingTreeView {
  return { ...view, readDeltaChunks: undefined, readDeltaVectors: undefined };
}
