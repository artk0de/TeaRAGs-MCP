import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import type { SchemaDrift } from "./schema-drift.js";

/** The single command a drift warning should recommend. */
export interface IndexDriftRemedy {
  kind: "none" | "reindex" | "recompute";
  hint: string;
}

/**
 * Pick ONE remedy for the whole drift.
 *
 * A full reindex rebuilds the enrichment layer as well, so a drift that mixes
 * enrichment-owned keys with chunker-owned ones escalates to the reindex and
 * drops the per-trajectory list — emitting two competing commands would leave
 * the reader to work out which one subsumes the other.
 */
export function resolveSchemaDriftRemedy(drift: SchemaDrift, owners: readonly PayloadKeyOwner[]): IndexDriftRemedy {
  if (drift.added.length === 0) {
    return {
      kind: "none",
      hint: "Removed fields are simply ignored by the current build — no action required.",
    };
  }
  const ownerByKey = new Map(owners.map((o) => [o.key, o]));
  const trajectories = new Set<string>();
  for (const key of drift.added) {
    const owner = ownerByKey.get(key);
    // An unattributed key is treated as chunker-owned: assuming it is cheap to
    // recompute would hand back a command that silently populates nothing.
    if (!owner?.recomputable || owner.trajectory === undefined) {
      return { kind: "reindex", hint: "Run: tea-rags index-codebase --force" };
    }
    trajectories.add(owner.trajectory);
  }
  const scope = [...trajectories].sort().join(",");
  return {
    kind: "recompute",
    hint: `Run: tea-rags index-codebase --force-enrichments ${scope}`,
  };
}
