import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import { renderIndexDriftRemedy, resolveSchemaDriftRemedy } from "./remedy.js";

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
 * Format a human-readable warning for schema drift.
 *
 * The hint names the narrowest command that actually repopulates the drifted
 * keys: an enrichment recompute when every new key belongs to a trajectory that
 * has an enrichment provider, a full reindex otherwise, and nothing at all when
 * the drift is removals only. Attribution is what narrows it — with no `owners`
 * to go on, every added key is unattributed and the warning escalates to the
 * full reindex, rendered by the same `renderIndexDriftRemedy` as every other
 * axis so a report never carries two competing commands (spec decision 14).
 */
export function formatSchemaDriftWarning(drift: SchemaDrift, owners: readonly PayloadKeyOwner[] = []): string {
  const remedy = resolveSchemaDriftRemedy(drift, owners);
  const lines: string[] = ["Payload schema changed since last indexing."];
  if (drift.added.length > 0) {
    const verb = remedy.kind === "recompute" ? "recompute" : "reindex";
    lines.push(`New fields: ${drift.added.join(", ")} (require ${verb} to populate)`);
  }
  if (drift.removed.length > 0) {
    lines.push(`Removed fields: ${drift.removed.join(", ")} (no longer used)`);
  }
  lines.push(renderIndexDriftRemedy(remedy));
  return lines.join("\n");
}
