import type {
  CollectionEntry,
  CollectionMemoryMetrics,
  IndexMetrics,
  IndexStatus,
  LanguageCapability,
} from "../../../core/api/public/index.js";

/**
 * What the project digest and metrics resources render — one project's index
 * state. Update checks and the auto-update verdict are CLI-only and stay off it.
 */
export interface ProjectDigestData {
  path: string;
  /** Registered alias, null when the registry entry has no name. */
  projectName: string | null;
  /** Registry entry backing the project — source of the `registry:` line and the git walk windows. */
  registry?: CollectionEntry | null;
  status: IndexStatus;
  /** Null when the project is not indexed or the metrics read failed. */
  metrics: IndexMetrics | null;
  /** Rendered `IndexDriftReport`; null = nothing moved. */
  drift: string | null;
  /** Qdrant's memory report for the collection; null when the server cannot report it. */
  memory?: CollectionMemoryMetrics | null;
  /** Static capability ceiling per language the metrics carry. */
  languageCapabilities?: ReadonlyMap<string, LanguageCapability>;
}

/** Narrowing of the metrics resource: one language, a subset of sections. */
export interface ProjectMetricsQuery {
  language?: string;
  section?: string[];
}
