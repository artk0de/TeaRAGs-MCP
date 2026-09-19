import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";

export type ArtifactId = "qdrant" | "codegraph" | "snapshot" | "stats" | "quarantine" | "indexing-lock";

/**
 * Which half of {@link ResolvedCollection} an artifact keys on — the choice the
 * footprint navigator calls "fixed and deliberate", stated as a declaration
 * instead of a convention.
 *
 * - `physical` — addressed by the versioned `_vN` name, so the artifact exists
 *   once PER GENERATION (Qdrant points, the codegraph DuckDB file).
 * - `logical` — addressed by the stable alias, so exactly one exists for the
 *   whole collection and it survives a version bump (snapshot, stats,
 *   quarantine).
 *
 * A full-footprint purge has to sweep every generation of the `physical` ones
 * while tearing the `logical` ones down once; without this field the caller
 * would have to re-encode the split by artifact id, which is precisely how the
 * shadow-DuckDB defect (bd 6goqa) diverged in the first place.
 */
export type ArtifactAddressing = "physical" | "logical";

export interface ResolvedCollection {
  logicalName: string;
  physicalName: PhysicalCollectionName;
  path: string;
  embeddingModel: string;
  embeddingDimensions: number;
  qdrantUrl: string;
  codegraphEnabled: boolean;
}

export interface FootprintContext {
  source: ResolvedCollection;
  target: ResolvedCollection;
  /**
   * Payload merged onto the TARGET's indexing marker point by the Qdrant clone,
   * after the recover and BEFORE the alias makes the target addressable by its
   * logical name (bd tea-rags-mcp-k8gac). The first-index worktree seed passes
   * the debt its collection will owe (`worktreeSeedPending`), so no instant
   * exists at which a run can see the clone without it. Rolled back with the
   * collection like everything else the Qdrant artifact wrote. Omitted → the
   * clone carries the source's marker unchanged (`WorktreeProvisioner#create`).
   */
  targetIndexingMarkerPatch?: Readonly<Record<string, unknown>>;
}

export interface CollectionArtifact {
  readonly id: ArtifactId;
  /** Whether this artifact keys on `physicalName` (per generation) or `logicalName` (per alias). */
  readonly addressing: ArtifactAddressing;
  clone: (ctx: FootprintContext) => Promise<void>;
  /**
   * Best-effort teardown of the TARGET artifact (used for create-saga rollback
   * and worktree removal). The orchestrator wraps each call, so an implementation
   * MAY throw; the caller treats a throw as a non-fatal skip. Multi-step removes
   * should still attempt every step internally (swallow per-step) so a single
   * failed step does not abandon the rest of that artifact's cleanup.
   */
  remove: (ctx: FootprintContext) => Promise<void>;
}
