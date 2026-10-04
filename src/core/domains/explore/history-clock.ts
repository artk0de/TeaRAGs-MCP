/**
 * The history clock of an explore request (bd tea-rags-mcp-zwu7m).
 *
 * The read path resolves ONE clock per request — the indexed commit's
 * committer time for a head-anchored index (`TRAJECTORY_GIT_ANCHOR=head`),
 * nothing for the wall clock — and carries it as `historyAnchorSec`. Every
 * rerank of the request reads it through this helper.
 */

import type { RerankOptions } from "./reranker.js";

/**
 * The `now` a request's rerank reads: its history clock when one was resolved,
 * nothing otherwise — so a wall-clock request passes exactly the options it
 * passed before the clock existed and `Reranker#rerank` keeps reading
 * `Date.now()` itself.
 */
export function historyClockRerankOption(request: { historyAnchorSec?: number }): Pick<RerankOptions, "now"> {
  return request.historyAnchorSec === undefined ? {} : { now: request.historyAnchorSec };
}
