/**
 * EnvDriftMonitor — reports indexing-env changes by what they invalidate
 * (bd tea-rags-mcp-lg361).
 *
 * Diffs the env snapshot the index run recorded against the env the NEXT run
 * on this collection would use — outer env > stored registry env > code
 * default, the replay `ProjectIngestFactory` performs before it builds an
 * ingest facade. A finding therefore means ONE thing: the outer env explicitly
 * overrides a stamped value. A changed code default is not drift, because
 * replay keeps the stamped value and the next run stays consistent with the
 * index (spec decision 6). Comparing against the bare server-process snapshot
 * instead would report permanent phantom drift for every project whose
 * registry env differs from the server's.
 *
 * Only keys present on BOTH sides can drift: a legacy entry without the key
 * and an unset optional carry no claim. `runtime` groups are skipped entirely
 * — they change how a run executes, never what it writes.
 *
 * The two ENABLE FLAGS are the one exception to the effective-env compare, and
 * `FLAG_NOTES` below says why.
 */

import type { CollectionEntry } from "../../../contracts/types/registry.js";
import type { CollectionRegistry } from "../registry/collection-registry.js";
import { REGISTRY_ENV_GROUPS, type EnvConsequence } from "../registry/env-groups.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import type { IndexDriftRemedy } from "./remedy.js";

/**
 * The two master switches whose flip removes a whole payload-key family, and
 * the note each one contributes. Membership in this map is also what routes a
 * key to the RUNNING composition instead of the effective env, because the two
 * facts are the same fact: a key belongs here exactly when its flip is what the
 * payload-key delta needs explained.
 *
 * These two cannot use the effective-env compare. Replay restores a stamped
 * flag whenever the ambient env merely LACKS it, so the effective env always
 * agrees with the stamp and the flip never surfaces — while the process doing
 * the reading built its composition from its OWN config, with no replay, and
 * therefore declares none of the family's descriptors. The payload-key axis
 * then reports the whole family removed and reads as "the schema changed,
 * rebuild", when the actual fix is env parity in the process that ran the
 * check. The standing offender is the `prime` SessionStart hook, which runs in
 * a fresh shell (memory: `project_codegraph_env_parity`).
 *
 * Their remedy is therefore `none`: restoring the flag is the fix and a rebuild
 * never is. The other direction needs no remedy from here either — a false →
 * true flip ADDS payload keys, and the payload-key axis carries its own
 * recompute for them, which the fold keeps.
 */
const FLAG_NOTES: Record<string, string> = {
  CODEGRAPH_ENABLED: "explains any codegraph.* payload-key drift — restore the flag instead of rebuilding",
  TRAJECTORY_GIT_ENABLED: "explains any git.* payload-key drift — restore the flag instead of rebuilding",
};

function remedyFor(consequence: EnvConsequence): IndexDriftRemedy {
  switch (consequence) {
    case "chunk-set":
      return { kind: "force" };
    case "enrichment:git":
      return { kind: "recompute", trajectories: new Set(["git"]), languages: null };
    case "enrichment:codegraph":
      return { kind: "recompute", trajectories: new Set(["codegraph"]), languages: null };
    case "runtime":
      return { kind: "none" };
  }
}

export class EnvDriftMonitor implements IndexDriftMonitor {
  readonly axis = "env" as const;

  constructor(
    private readonly registry: Pick<CollectionRegistry, "get">,
    /**
     * Builds the env the next index run on this collection would use, from the
     * stamp. Injected rather than imported because it belongs to `bootstrap/`
     * (`buildEffectiveIndexEnvSnapshot`, which `core/` must not import) — and
     * because it is the only part of this axis that reads the process env,
     * which the monitor itself never does. It takes the collection name so a
     * stamp it cannot parse can be reported against the project it belongs to.
     */
    private readonly effectiveSnapshotFor: (
      stored: Readonly<Record<string, string>>,
      collectionName: string,
    ) => Readonly<Record<string, string>>,
    /**
     * What the RUNNING composition resolved the indexing env to — this
     * process's own config, with no registry replay. Consulted for the two
     * enable flags only (see `FLAG_NOTES`), and built once at composition time
     * because it cannot vary per collection.
     */
    private readonly runningSnapshot: Readonly<Record<string, string>>,
  ) {}

  /** One finding per overridden key, each carrying what THAT key invalidates. */
  check(collectionName: string): IndexDriftFinding[] {
    const stored = stampedEnv(this.registry.get(collectionName));
    if (!stored) return [];
    const effective = this.effectiveSnapshotFor(stored, collectionName);
    const findings: IndexDriftFinding[] = [];
    for (const group of REGISTRY_ENV_GROUPS) {
      if (group.consequence === "runtime") continue;
      const note = FLAG_NOTES[group.canonical];
      const indexed = stored[group.canonical];
      const current = note === undefined ? effective[group.canonical] : this.runningSnapshot[group.canonical];
      if (indexed === undefined || current === undefined || indexed === current) continue;
      findings.push({
        axis: this.axis,
        subject: group.canonical,
        indexed,
        current,
        remedy: note === undefined ? remedyFor(group.consequence) : { kind: "none" },
        ...(note ? { note } : {}),
      });
    }
    return findings;
  }
}

/**
 * The env the run recorded, composed exactly the way `resolveRegistryEnv`
 * composes its replay set: the general snapshot (`entry.env`; entries written
 * before 9vpnz stored it as `entry.tuning`) plus the identity keys that live
 * in DEDICATED CollectionEntry fields.
 *
 * That composition is what makes a `CODEGRAPH_ENABLED` flip visible at all.
 * `buildRegistryEnvSnapshot` skips every DEDICATED_FIELD_ENV_KEY, so the flag
 * this monitor exists to attribute is in NEITHER side of the diff without it.
 * Only the two dedicated keys that carry a non-runtime consequence are
 * composed; the three URL-shaped ones are `runtime` and would be skipped.
 *
 * `codegraphEnabled` is recorded only when it was on — a run indexed with
 * codegraph off leaves no stamp, so an off → on move carries no claim here. It
 * needs none: that direction ADDS payload keys, which is the payload-key axis's
 * own finding.
 */
function stampedEnv(entry: CollectionEntry | null): Record<string, string> | null {
  const snapshot = entry?.env ?? entry?.tuning;
  if (!entry || !snapshot) return null;
  const stamped: Record<string, string> = { ...snapshot };
  if (entry.embeddingModel) stamped.EMBEDDING_MODEL = entry.embeddingModel;
  if (entry.codegraphEnabled) stamped.CODEGRAPH_ENABLED = "true";
  return stamped;
}
