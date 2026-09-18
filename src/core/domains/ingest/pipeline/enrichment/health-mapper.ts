/**
 * Maps the persisted enrichment marker (payload.enrichment) to API-facing
 * health, under the terminal-only + runId-staleness model.
 *
 * Storage shape:
 *   enrichment._run = { runId, startedAt, lastProgressAt, providers[] }
 *   enrichment.<provider-as-nested-path>.{file,chunk} = terminal marker w/ runId
 *     (e.g. enrichment.git.file, enrichment.codegraph.symbols.chunk)
 *
 * The FRAME — which providers get a row — is the RUNNING composition's provider
 * list, passed in by the caller, NOT `_run.providers` (bd tea-rags-mcp-x2u65).
 * `--force-enrichments codegraph` writes a run marker naming `codegraph.symbols`
 * alone, and framing on it dropped the git row from prime's `## Enrichment` and
 * from `get_index_status` while git signals sat on every point.
 *
 * Read logic, per ACTIVE provider:
 *   - Covered by the last run (`_run.providers`) — the run's timestamps describe
 *     it, so today's model applies:
 *       - a per-kind marker whose `runId` matches `_run.runId` renders its
 *         TERMINAL status (completed→healthy, degraded, failed);
 *       - a marker that is ABSENT or carries a STALE runId is derived from
 *         `_run` timestamps: crashed (no progress > 1h) → failed, past the stall
 *         deadline (default 15min, ENRICHMENT_STALL_DEADLINE_MS) → failed,
 *         stalled (> 2min) → in_progress warning, fresh → in_progress. It is
 *         NEVER rendered healthy — that was the old `pending → healthy` bug.
 *   - NOT covered by the last run — the run's timestamps say nothing about it:
 *       - a terminal marker at a level renders from that marker, whichever run
 *         wrote it (the latest terminal marker is the truth about that level);
 *       - a non-terminal or absent level means the provider's own last run never
 *         finished → failed, recovered by the next run that covers it;
 *       - no marker at all on either level → the provider is omitted entirely.
 *   - Providers with markers that are NOT active (git switched off by flag) are
 *     omitted; the indexing-env drift axis is what explains that case.
 *   - Legacy markers (no `_run`, old literal-property shape) fall back to a
 *     compatibility branch that frames on the marker map itself: terminal
 *     statuses render as-is, legacy `pending` maps to in_progress (never
 *     healthy), legacy `in_progress` keeps the time-based crash check.
 */

import type { EnrichmentHealthMap, EnrichmentLevelHealth, EnrichmentMarkerMap, RunMarker } from "./types.js";

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const CRASHED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour — pipeline crashed long ago
const DEFAULT_STALL_DEADLINE_MS = 15 * 60 * 1000; // 15 minutes — in_progress past this renders failed

/**
 * Stall deadline (ms): an in_progress level whose last heartbeat is older than
 * this renders `failed` (recovered on next reindex) instead of warning
 * "stalled" forever — a dead enrichment process must not pin health at
 * in_progress eternally. Defaults to 15 minutes; overridable via the
 * `ENRICHMENT_STALL_DEADLINE_MS` env var (positive integer ms; invalid or
 * non-positive values fall back to the default), mirroring how
 * `CHUNKER_WORKER_TIMEOUT_MS` tunes the chunker pool in
 * `pipeline/infra/pool-defaults.ts`.
 */
function stallDeadlineMs(): number {
  const raw = process.env.ENRICHMENT_STALL_DEADLINE_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STALL_DEADLINE_MS;
}

/** Failed-past-deadline message — names the stall duration, mirrors the crashed-message style. */
function stallDeadlineMessage(elapsedMs: number, deadlineMs: number): string {
  const elapsedMin = Math.round(elapsedMs / 60_000);
  const deadlineMin = Math.round(deadlineMs / 60_000);
  return `Enrichment appears stalled — no progress in ${elapsedMin} minutes, past the stall deadline (${deadlineMin} min). Status recovered on read. Will recover on next reindex.`;
}

type LevelRecord = Record<string, unknown>;

/** Statuses a level marker can carry that describe a FINISHED attempt. */
const TERMINAL_STATUSES: ReadonlySet<unknown> = new Set(["completed", "degraded", "failed"]);

/**
 * @param activeEnrichmentProviders provider keys of the RUNNING composition —
 *   the frame. The caller owns it because only the composition root knows which
 *   providers this process enriches with (git drops out when
 *   `enableGitMetadata` is off). Same spelling all the way down the wiring
 *   chain (bootstrap → facade → ops → query / StatusModule) so one grep finds
 *   every hop. Empty → nothing to report under the run-pointer model.
 */
export function mapMarkerToHealth(
  markerMap: EnrichmentMarkerMap,
  activeEnrichmentProviders: readonly string[],
): EnrichmentHealthMap | undefined {
  const run = markerMap._run;
  return run ? mapWithRunPointer(markerMap, run, activeEnrichmentProviders) : mapLegacy(markerMap);
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
    const entry = getNested(markerMap, providerKey) as { file?: LevelRecord; chunk?: LevelRecord } | undefined;
    return !isTerminalForRun(entry?.file, run) || !isTerminalForRun(entry?.chunk, run);
  });
  if (!owesTerminal) return false;
  const progressAt = Date.parse(run.lastProgressAt ?? run.startedAt);
  if (Number.isNaN(progressAt)) return false;
  if (progressAt <= (options.progressAfter ?? Number.NEGATIVE_INFINITY)) return false;
  return (options.now ?? Date.now()) - progressAt <= STALE_THRESHOLD_MS;
}

function isTerminalForRun(level: LevelRecord | undefined, run: RunMarker): boolean {
  return level?.runId === run.runId && TERMINAL_STATUSES.has(level.status);
}

/** Terminal-only path: navigate the nested marker of every ACTIVE provider. */
function mapWithRunPointer(
  markerMap: EnrichmentMarkerMap,
  run: RunMarker,
  activeEnrichmentProviders: readonly string[],
): EnrichmentHealthMap | undefined {
  const health: EnrichmentHealthMap = {};
  const coveredByRun = new Set(run.providers ?? []);
  let hasAny = false;
  for (const providerKey of activeEnrichmentProviders) {
    const entry = getNested(markerMap, providerKey) as { file?: LevelRecord; chunk?: LevelRecord } | undefined;
    if (coveredByRun.has(providerKey)) {
      hasAny = true;
      health[providerKey] = {
        file: mapLevelWithRun(entry?.file, "file", run),
        chunk: mapLevelWithRun(entry?.chunk, "chunk", run),
      };
      continue;
    }
    // Outside the last run: no marker at all means the provider has never run
    // against this collection — a row saying "failed" would invent a failure.
    if (!entry?.file && !entry?.chunk) continue;
    hasAny = true;
    health[providerKey] = {
      file: mapLevelOutsideRun(entry.file, "file"),
      chunk: mapLevelOutsideRun(entry.chunk, "chunk"),
    };
  }
  return hasAny ? health : undefined;
}

/**
 * Render a level of a provider the last run did not touch. The run's heartbeat
 * describes some other provider's work, so it is not evidence here: a terminal
 * marker stands on its own, and anything else means that provider's own last
 * run never reached a terminal state.
 */
function mapLevelOutsideRun(level: LevelRecord | undefined, levelName: "file" | "chunk"): EnrichmentLevelHealth {
  if (level && TERMINAL_STATUSES.has(level.status)) return renderTerminal(level, levelName);
  const prefix = levelName === "file" ? "File-level enrichment" : "Chunk enrichment";
  return {
    ...(level ? pickMeta(level) : {}),
    status: "failed",
    message: `${prefix} never finished on this provider's last run. Will recover on next reindex.`,
  };
}

/** Render a single level under the run-pointer model. */
function mapLevelWithRun(
  level: LevelRecord | undefined,
  levelName: "file" | "chunk",
  run: RunMarker,
): EnrichmentLevelHealth {
  // Marker present AND produced by the active/latest run → render terminal.
  if (level?.runId === run.runId) {
    return renderTerminal(level, levelName);
  }
  // Absent OR stale runId → derive from the run-pointer timestamps. Never healthy.
  const since = Date.parse(run.lastProgressAt ?? run.startedAt);
  const elapsed = Number.isNaN(since) ? 0 : Date.now() - since;
  if (elapsed > CRASHED_THRESHOLD_MS) {
    return {
      status: "failed",
      message:
        "Enrichment appears to have crashed (no progress for over 1 hour). Status recovered on read. Will retry on next reindex.",
    };
  }
  const deadlineMs = stallDeadlineMs();
  if (elapsed > deadlineMs) {
    return { status: "failed", message: stallDeadlineMessage(elapsed, deadlineMs) };
  }
  if (elapsed > STALE_THRESHOLD_MS) {
    return {
      status: "in_progress",
      message: "Enrichment appears stalled — no progress in 2 minutes. May need reindex.",
    };
  }
  return { status: "in_progress", message: "Enrichment in progress..." };
}

/** Render a terminal status (completed/degraded/failed) with its metadata fields. */
function renderTerminal(level: LevelRecord, levelName: "file" | "chunk"): EnrichmentLevelHealth {
  const base = pickMeta(level);
  if (level.status === "completed") return { ...base, status: "healthy" };
  if (level.status === "degraded") {
    return {
      ...base,
      status: "degraded",
      message: `${String(level.unenrichedChunks)} chunks missing ${levelName}-level signals. Will recover on next reindex.`,
    };
  }
  // failed (or any non-terminal value defensively treated as failed)
  const fallback =
    levelName === "file"
      ? "File-level enrichment failed. All file-level signals missing. Will recover on next reindex."
      : "Chunk enrichment failed. Will recover on next reindex.";
  return {
    ...base,
    status: "failed",
    message: level.errorMessage ? `${fallback} (${level.errorMessage as string})` : fallback,
  };
}

/**
 * Back-compat for collections indexed before the terminal-only redesign:
 * `enrichment` is a flat map of literal provider keys → { file, chunk } with
 * the old status vocabulary (incl. pending / in_progress). No `_run` pointer.
 */
function mapLegacy(markerMap: EnrichmentMarkerMap): EnrichmentHealthMap | undefined {
  const health: EnrichmentHealthMap = {};
  let hasAny = false;
  for (const [key, marker] of Object.entries(markerMap)) {
    if (key === "_run") continue;
    const m = marker as { file?: LevelRecord; chunk?: LevelRecord } | undefined;
    if (!m?.file && !m?.chunk) continue;
    hasAny = true;
    health[key] = { file: mapLegacyLevel(m.file, "file"), chunk: mapLegacyLevel(m.chunk, "chunk") };
  }
  return hasAny ? health : undefined;
}

function mapLegacyLevel(level: LevelRecord | undefined, levelName: "file" | "chunk"): EnrichmentLevelHealth {
  // Legacy "pending" / missing is NO LONGER healthy — render in_progress so a
  // never-finished legacy run cannot masquerade as healthy.
  if (!level || level.status === "pending") {
    return { status: "in_progress", message: "Enrichment in progress..." };
  }
  if (level.status === "in_progress") {
    const base = pickMeta(level);
    const crashedLongAgo =
      typeof level.startedAt === "string" &&
      level.completedAt === undefined &&
      Date.now() - Date.parse(level.startedAt) > CRASHED_THRESHOLD_MS;
    if (crashedLongAgo) {
      return {
        ...base,
        status: "failed",
        message:
          "Enrichment appears to have crashed (in_progress for over 1 hour with no completion). Status recovered on read. Will retry on next reindex.",
      };
    }
    // Heartbeat age. Absent lastProgressAt yields undefined; an unparseable
    // one yields NaN — both fail every comparison below (same as before).
    const heartbeatAgeMs =
      typeof level.lastProgressAt === "string" ? Date.now() - Date.parse(level.lastProgressAt) : undefined;
    const deadlineMs = stallDeadlineMs();
    if (heartbeatAgeMs !== undefined && heartbeatAgeMs > deadlineMs) {
      return { ...base, status: "failed", message: stallDeadlineMessage(heartbeatAgeMs, deadlineMs) };
    }
    const isStale = heartbeatAgeMs !== undefined && heartbeatAgeMs > STALE_THRESHOLD_MS;
    return {
      ...base,
      status: "in_progress",
      message: isStale
        ? "Enrichment appears stalled — no progress in 2 minutes. May need reindex."
        : "Enrichment in progress...",
    };
  }
  return renderTerminal(level, levelName);
}

/** Copy the optional metadata fields surfaced in health output. */
function pickMeta(level: LevelRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (level.unenrichedChunks) base.unenrichedChunks = level.unenrichedChunks;
  if (level.startedAt) base.startedAt = level.startedAt;
  if (level.completedAt) base.completedAt = level.completedAt;
  if (level.durationMs !== undefined) base.durationMs = level.durationMs;
  if (level.matchedFiles !== undefined) base.matchedFiles = level.matchedFiles;
  if (level.missedFiles !== undefined) base.missedFiles = level.missedFiles;
  if (level.ignoredFiles !== undefined) base.ignoredFiles = level.ignoredFiles;
  return base;
}

/** Navigate a dotted path into a nested object; undefined if any segment missing. */
function getNested(obj: LevelRecord, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as LevelRecord)[seg];
  }
  return cur;
}
