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
 */

import type { CollectionEntry } from "../../../contracts/types/registry.js";
import type { CollectionRegistry } from "../registry/collection-registry.js";
import { REGISTRY_ENV_GROUPS, type EnvConsequence } from "../registry/env-groups.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import type { IndexDriftRemedy } from "./remedy.js";

/**
 * The two master switches whose flip removes a whole payload-key family. The
 * payload-key axis sees those keys vanish and reads as "the schema changed,
 * rebuild"; this note names the actual cause so the reader restores env parity
 * instead — the standing offender being a process (the `prime` SessionStart
 * hook, a bare shell) that never had the flag.
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
     * which the monitor itself never does.
     */
    private readonly effectiveSnapshotFor: (
      stored: Readonly<Record<string, string>>,
    ) => Readonly<Record<string, string>>,
  ) {}

  /** One finding per overridden key, each carrying what THAT key invalidates. */
  check(collectionName: string): IndexDriftFinding[] {
    const stored = stampedEnv(this.registry.get(collectionName));
    if (!stored) return [];
    const effective = this.effectiveSnapshotFor(stored);
    const findings: IndexDriftFinding[] = [];
    for (const group of REGISTRY_ENV_GROUPS) {
      if (group.consequence === "runtime") continue;
      const indexed = stored[group.canonical];
      const current = effective[group.canonical];
      if (indexed === undefined || current === undefined || indexed === current) continue;
      const note = FLAG_NOTES[group.canonical];
      findings.push({
        axis: this.axis,
        subject: group.canonical,
        indexed,
        current,
        remedy: remedyFor(group.consequence),
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
