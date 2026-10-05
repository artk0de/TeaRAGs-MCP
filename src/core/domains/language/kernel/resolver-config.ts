/**
 * Per-resolver config shared by the Ruby and Python symbol-resolution
 * strategies, and the one reader that builds it from the environment.
 *
 * Both resolvers read the same two knobs under their own env prefix
 * (`CODEGRAPH_RB_*` / `CODEGRAPH_PY_*`); the parsing lived twice, byte for
 * byte, in `ruby-resolver.ts` and `python-resolver.ts`.
 */

import { DEFAULT_AMBIGUOUS_RESOLVE_MODE, type AmbiguousResolveMode } from "../../../contracts/types/codegraph.js";

/** Default cone-size threshold; `<prefix>_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge. `|cone| ≤ coneMax` persists N `cone` edges (confidence
   * `1/N`); `> coneMax` persists one base-decl edge expanded at query time.
   * Strategies default it to `CONE_MAX_DEFAULT` when omitted;
   * {@link readResolverConfig} always sets it.
   */
  coneMax?: number;
  /**
   * Confidence weight applied to a dynamic-receiver short-name fan-out edge
   * BEFORE the per-candidate `1/N` split (a float in `(0,1]`). Only the Ruby
   * resolver consumes it; absent → the consumer's own default.
   */
  dynamicReceiverConfidence?: number;
  /**
   * Whether the dynamic short-name fan declines a receiver the caller's def
   * ASSIGNS but no typed channel answered (bd tea-rags-mcp-m99j1.1.59). Only the
   * Ruby resolver consumes it; absent → the consumer's own default.
   */
  assignedLocalGate?: boolean;
}

/** Config as returned by the reader: `coneMax` is always resolved. */
export type ResolvedResolverConfig = ResolverConfig & { coneMax: number };

export type ResolverEnvPrefix = "CODEGRAPH_RB" | "CODEGRAPH_PY";

function parseConeMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : CONE_MAX_DEFAULT;
}

function parseDynamicConfidence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

function parseFlag(raw: string | undefined): boolean | undefined {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

/**
 * Read `<prefix>_CONE_MAX` (positive integer, else `CONE_MAX_DEFAULT`) and
 * `<prefix>_DYNAMIC_CONFIDENCE` (float in `(0,1]`, else `undefined`) and
 * `<prefix>_ASSIGNED_LOCAL_GATE` (`1`/`true`, `0`/`false`, else `undefined`).
 */
export function readResolverConfig(
  env: NodeJS.ProcessEnv,
  prefix: ResolverEnvPrefix,
  mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
): ResolvedResolverConfig {
  return {
    mode,
    coneMax: parseConeMax(env[`${prefix}_CONE_MAX`]),
    dynamicReceiverConfidence: parseDynamicConfidence(env[`${prefix}_DYNAMIC_CONFIDENCE`]),
    assignedLocalGate: parseFlag(env[`${prefix}_ASSIGNED_LOCAL_GATE`]),
  };
}
