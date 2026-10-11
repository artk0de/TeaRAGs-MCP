/**
 * The run-liveness predicate over the persisted enrichment marker.
 *
 * Lives in `ingest/infra` — below the pipeline — because the collection lease
 * (`collection-build-lease`) and the indexing-marker codec read the marker to
 * tell a running enrichment from an idle one. The health mapper in
 * `pipeline/enrichment` renders the same marker for the API and imports the
 * shared threshold, terminal-status set and nested lookup from here. The marker
 * types themselves live in `contracts/types/enrichment.ts` (explore reads them
 * too) and are re-exported here so ingest keeps its import paths.
 */

import type { EnrichmentMarkerMap, RunMarker } from "../../../contracts/types/enrichment.js";

export type {
  ChunkEnrichmentMarker,
  EnrichmentLevelMarker,
  EnrichmentLevelStatus,
  EnrichmentMarkerMap,
  FileEnrichmentMarker,
  ProviderEnrichmentMarker,
  RunMarker,
} from "../../../contracts/types/enrichment.js";

/** An enrichment level record as read off the persisted marker (untyped payload). */
export type EnrichmentLevelRecord = Record<string, unknown>;

/** Stalled threshold: a run silent for longer reads as stalled, not in progress. */
export const ENRICHMENT_STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/** Statuses a level marker can carry that describe a FINISHED attempt. */
export const ENRICHMENT_TERMINAL_STATUSES: ReadonlySet<unknown> = new Set(["completed", "degraded", "failed"]);

/** Navigate a dotted provider key (`codegraph.symbols`) through the nested marker tree. */
export function getNestedMarker(obj: EnrichmentLevelRecord, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as EnrichmentLevelRecord)[seg];
  }
  return cur;
}

/**
 * Is the enrichment run the `_run` pointer names still running (bd
 * tea-rags-mcp-62pgi)? Live means: some provider the run covers still owes a
 * terminal marker carrying the run's `runId` at either level, AND the run's last
 * progress is within the same stalled threshold `mapLevelWithRun` renders as
 * "Enrichment in progress..." — past it the run reads as stalled, and a crashed
 * run must not be mistaken for a live one.
 *
 * `progressAfter` (epoch ms) discounts progress stamped at or before it: the
 * caller's own finished run left that evidence, so it proves nothing about
 * anyone else.
 */
export function isEnrichmentRunLive(
  markerMap: EnrichmentMarkerMap,
  options: { now?: number; progressAfter?: number } = {},
): boolean {
  const run = markerMap._run;
  if (!run) return false;
  const owesTerminal = (run.providers ?? []).some((providerKey) => {
    const entry = getNestedMarker(markerMap, providerKey) as
      | { file?: EnrichmentLevelRecord; chunk?: EnrichmentLevelRecord }
      | undefined;
    return !isTerminalForRun(entry?.file, run) || !isTerminalForRun(entry?.chunk, run);
  });
  if (!owesTerminal) return false;
  const progressAt = Date.parse(run.lastProgressAt ?? run.startedAt);
  if (Number.isNaN(progressAt)) return false;
  if (progressAt <= (options.progressAfter ?? Number.NEGATIVE_INFINITY)) return false;
  return (options.now ?? Date.now()) - progressAt <= ENRICHMENT_STALE_THRESHOLD_MS;
}

function isTerminalForRun(level: EnrichmentLevelRecord | undefined, run: RunMarker): boolean {
  return level?.runId === run.runId && ENRICHMENT_TERMINAL_STATUSES.has(level.status);
}
