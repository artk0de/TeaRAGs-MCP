/**
 * The persisted enrichment marker format and the run-liveness predicate over it.
 *
 * Lives in `ingest/infra` — below the pipeline — because the collection lease
 * (`collection-build-lease`) and the indexing-marker codec read the marker to
 * tell a running enrichment from an idle one. The health mapper in
 * `pipeline/enrichment` renders the same marker for the API and imports the
 * shared threshold, terminal-status set and nested lookup from here.
 */

// --- Enrichment marker types (per-provider, per-level) ---

/**
 * Run-pointer — the ONLY pre-completion marker write. Lives at
 * `payload.enrichment._run`. Written once at run start (`markRunStart`) and
 * refreshed by a throttled heartbeat.
 *
 * It is evidence about the providers it COVERS (`providers`) and about nobody
 * else. For a covered provider the health mapper compares each per-kind
 * marker's `runId` against `runId` here to detect stale/in-flight work (a
 * marker whose runId differs is derived from these timestamps — in_progress or
 * failed, never healthy). For an ACTIVE provider this run did not cover, these
 * timestamps describe someone else's work and are not consulted at all: its own
 * latest terminal marker stands. See `health-mapper.ts` for the full frame.
 */
export interface RunMarker {
  runId: string;
  startedAt: string;
  /** Throttled heartbeat; advanced on real apply progress. */
  lastProgressAt: string;
  /**
   * Provider keys THIS RUN covered — a coverage set, not the frame of the
   * health report. `--force-enrichments codegraph` writes a run naming
   * `codegraph.symbols` alone while git markers from an earlier run stay valid
   * on the same points, so the health mapper navigates from the RUNNING
   * COMPOSITION's provider list (passed in by the caller) and consults this
   * list only to decide whether the run's timestamps describe a given provider.
   *
   * Markers are stored NESTED (`enrichment.codegraph.symbols.file`, matching
   * the applier's codegraph convention), so the marker tree is not
   * self-describing — a dotted key like `codegraph.symbols` is
   * indistinguishable from nesting. Both lists are dotted keys read the same
   * way, which is why either can drive the navigation.
   */
  providers: string[];
}

/**
 * PERSISTED per-level status is terminal-only. `in_progress` / `pending` /
 * `stalled` are NEVER written — they are DERIVED at read time by the health
 * mapper from the `_run` pointer, for a provider the run covers (absent or
 * stale-runId marker). An active provider the run does NOT cover is never
 * derived as in progress: its own terminal marker renders as is, and a missing
 * or non-terminal one renders as a derived `failed`. See
 * `EnrichmentLevelHealth` for the API-facing (derived) status union.
 */
export type EnrichmentLevelStatus = "completed" | "degraded" | "failed";

export interface EnrichmentLevelMarker {
  /** The run that produced this terminal marker (staleness key). */
  runId?: string;
  status: EnrichmentLevelStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  /** Files intentionally skipped by per-file enrichment policy (not a failure). */
  ignoredFiles?: number;
  unenrichedChunks: number;
  /**
   * Propagated error message when `status === "failed"`. Surfaced to
   * `get_index_status` via the health mapper so MCP consumers see the
   * concrete failure (e.g. "Codegraph spill write failed at .spill/…")
   * instead of a generic failure placeholder.
   */
  errorMessage?: string;
}

export type FileEnrichmentMarker = EnrichmentLevelMarker;

export type ChunkEnrichmentMarker = EnrichmentLevelMarker;

export interface ProviderEnrichmentMarker {
  runId: string;
  file: FileEnrichmentMarker;
  chunk: ChunkEnrichmentMarker;
}

/**
 * Shape stored in Qdrant metadata point (ID=1) payload.enrichment.
 * Per-provider entries are keyed by provider key; `_run` holds the run-pointer.
 */
export type EnrichmentMarkerMap = {
  _run?: RunMarker;
} & Record<string, ProviderEnrichmentMarker | RunMarker | undefined>;

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
