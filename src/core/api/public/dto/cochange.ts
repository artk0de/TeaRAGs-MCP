/**
 * find_co_changed DTOs (bd tea-rags-mcp-l1ot.1) — co-change partners from the
 * temporal sub-graph (`cg_temporal_*`). Partner shapes are the domain's
 * ranking output aliased here, so the public contract and the domain answer
 * cannot drift apart: ops returns the ranking as-is.
 */

import type { TemporalCochangeBuildMeta } from "../../../contracts/types/codegraph.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import type {
  FileCochangeRanking,
  RankedCochangePartner,
} from "../../../domains/trajectory/codegraph/temporal/partners/index.js";

export interface FindCoChangedRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /** Project-relative paths to query; at least one. */
  files: string[];
  /** Max partners per file (default 10). */
  limit?: number;
}

/** One co-change partner of the queried file, from the queried file's perspective. */
export type CoChangedPartner = RankedCochangePartner;

/** One queried file's answer. */
export type CoChangedFileResult = FileCochangeRanking;

export interface CoChangeBuildProvenance extends TemporalCochangeBuildMeta {
  /** `"session"` = author-session bundling (`sessionGapMinutes` set); `"commit"` = one bundle per commit. */
  mode: "commit" | "session";
}

export interface FindCoChangedResult {
  /**
   * `false` = no co-change build has run for this collection yet — run a
   * codegraph enrichment, never read it as "no partners".
   */
  built: boolean;
  provenance?: CoChangeBuildProvenance;
  files: CoChangedFileResult[];
  /** Which tree the answer was read beside (bd tea-rags-mcp-xi2r9) — co-change is the index's history. */
  workingTree?: WorkingTreeMarker;
}
