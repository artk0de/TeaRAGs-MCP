/**
 * TemporalTrajectory L2 — the co-change sub-graph of the codegraph family
 * (epic tea-rags-mcp-l1ot, Slice 5; bd tea-rags-mcp-x4rpp).
 *
 * Process-derived, not AST-derived: which files change together in history,
 * stored as association rules in `cg_temporal_*` beside `cg_symbols_*`. The
 * graph is language-agnostic by construction — git does not know languages —
 * so code↔config and code↔migration pairs are in it where no static graph can
 * see them.
 *
 * Phase 1 carries no payload: the trajectory registers with empty signal,
 * filter and preset lists, and its tables are (re)built through the family's
 * collection-completion hook (`TemporalCochangeBuilder`), which the symbols
 * provider runs once a collection's graph is whole. Payload signals and presets
 * are the spec's Phase 2/3.
 */

import type { GitAdapterKind } from "../../../../adapters/vcs/types.js";
import type { Trajectory } from "../../../../contracts/types/trajectory.js";
import type { CodegraphCollectionCompletionHook } from "../collection-completion-hook.js";
import { TemporalCochangeBuilder } from "./cochange/builder.js";

/** Registered trajectory key — gates anything that depends on the co-change graph. */
export const CODEGRAPH_TEMPORAL_TRAJECTORY_KEY = "codegraph.temporal";

/**
 * Structured-clone-safe co-change build config — rides `CodegraphWorkerConfig`
 * to the pinned worker, where `createTemporalCochangeHooks` rebuilds the hook.
 * Every field is the git trajectory's own setting, so both read one history.
 */
export interface TemporalCochangeConfig {
  /** `chunkMaxAgeMonths` — the discovery window both trajectories share. */
  windowMonths: number;
  /** `sessionGapMinutes` when squash-aware sessions are on, else `null`. */
  sessionGapMinutes: number | null;
  /** `GIT_ADAPTER`. */
  vcsAdapter: GitAdapterKind;
  /** `chunkTimeoutMs`. */
  gitTimeoutMs: number;
}

/** The temporal sub-graph's completion hooks; none when git history is off. */
export function createTemporalCochangeHooks(config?: TemporalCochangeConfig): CodegraphCollectionCompletionHook[] {
  return config ? [new TemporalCochangeBuilder(config)] : [];
}

export function createTemporalTrajectory(): Trajectory {
  return {
    key: CODEGRAPH_TEMPORAL_TRAJECTORY_KEY,
    name: "CodegraphTemporal",
    description: "File co-change sub-graph (association rules over commit history)",
    payloadSignals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
  };
}

export * from "./boundary-diagnostics/index.js";
export * from "./cochange/index.js";
