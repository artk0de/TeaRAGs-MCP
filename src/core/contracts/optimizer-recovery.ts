/**
 * Optimizer-recovery contract — the failure predicate and the remedy's
 * rendering rule (bd tea-rags-mcp-89k7k.22).
 *
 * Pure vocabulary over status strings, with no adapter or domain dependency:
 * `get_index_status` and `prime` (both the CLI and MCP arms) render a failed
 * Qdrant optimizer with the SAME predicate and the SAME ready-to-run command
 * line the write path (`OptimizerRecoveryOps`, `api/internal/ops/`) acts on.
 * Rendering rules of a consumer-facing contract live in `contracts/` — the
 * `resolve-rate` precedent — and re-export through `api/public`, so the
 * stable contract layer never reaches into the unstable api component for
 * them.
 */

import { shellQuote } from "./shell-quote.js";

/** Which project to recover: by registry alias, or by project path. */
export interface OptimizerRecoveryTarget {
  project?: string;
  path?: string;
}

export type OptimizerRecoveryOutcome =
  | { outcome: "nothing-to-do"; collectionName: string; optimizerStatus: string }
  | { outcome: "cleared"; collectionName: string; previousOptimizerStatus: string; optimizerStatus: string };

/** Prefix `QdrantCollectionAdmin#getCollectionInfo` gives the failed arm of the optimizer status. */
const OPTIMIZER_ERROR_PREFIX = "error:";

/** True when a rendered optimizer status is Qdrant's `{ error }` arm. */
export function isOptimizerFailure(optimizerStatus: string | undefined): boolean {
  return optimizerStatus?.startsWith(OPTIMIZER_ERROR_PREFIX) ?? false;
}

/** The ready-to-run recovery line the status surfaces print — alias when known, else the path. */
export function renderOptimizerRecoveryCommand(target: OptimizerRecoveryTarget): string {
  const address = target.project ? `--project ${target.project}` : `--path ${shellQuote(target.path ?? ".")}`;
  return `Run: tea-rags qdrant recover ${address}`;
}
