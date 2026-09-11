import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import { resolveSchemaDriftRemedy, type IndexDriftRemedy } from "./remedy.js";

export interface SchemaDrift {
  added: string[];
  removed: string[];
}

/** Compare cached payload keys vs current. Returns null if no drift or no cached keys. */
export function checkSchemaDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
  if (!cachedKeys) return null;
  const cachedSet = new Set(cachedKeys);
  const currentSet = new Set(currentKeys);
  const added = currentKeys.filter((k) => !cachedSet.has(k));
  const removed = cachedKeys.filter((k) => !currentSet.has(k));
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/**
 * Human-readable warning. With `owners`, the hint names the narrowest command
 * that repopulates the drifted keys; without them the legacy full-reindex hint
 * is kept for callers that have no attribution to give.
 */
export function formatSchemaDriftWarning(drift: SchemaDrift, owners?: readonly PayloadKeyOwner[]): string {
  const remedy: IndexDriftRemedy | null = owners ? resolveSchemaDriftRemedy(drift, owners) : null;
  const lines: string[] = ["Payload schema changed since last indexing."];
  if (drift.added.length > 0) {
    const verb = remedy?.kind === "recompute" ? "recompute" : "reindex";
    lines.push(`New fields: ${drift.added.join(", ")} (require ${verb} to populate)`);
  }
  if (drift.removed.length > 0) {
    lines.push(`Removed fields: ${drift.removed.join(", ")} (no longer used)`);
  }
  lines.push(remedy ? remedy.hint : "Run index_codebase with forceReindex=true to update.");
  return lines.join("\n");
}
