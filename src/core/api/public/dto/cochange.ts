/**
 * find_co_changed DTOs (bd tea-rags-mcp-l1ot.1) — co-change partners from the
 * temporal sub-graph (`cg_temporal_*`). Partner shapes are the contract
 * types the domain's ranking returns (`contracts/types/codegraph-temporal.ts`),
 * aliased here, so the public contract and the domain answer cannot drift
 * apart: ops returns the ranking as-is.
 */

import type {
  FileCochangeRanking,
  RankedCochangePartner,
  TemporalCochangeBuildMeta,
} from "../../../contracts/types/codegraph.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";

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

/**
 * How the graph was built. Bundles are always one per commit, counted once per
 * author burst under `burstWindowMinutes` (bd tea-rags-mcp-3vg0x) — the old
 * `mode: "commit" | "session"` split is gone with session bundling.
 */
export type CoChangeBuildProvenance = TemporalCochangeBuildMeta;

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
