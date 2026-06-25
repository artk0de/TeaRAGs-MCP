export type ArtifactId = "qdrant" | "codegraph" | "snapshot" | "stats" | "quarantine";

export interface ResolvedCollection {
  logicalName: string;
  physicalName: string;
  path: string;
  embeddingModel: string;
  embeddingDimensions: number;
  qdrantUrl: string;
  codegraphEnabled: boolean;
}

export interface FootprintContext {
  source: ResolvedCollection;
  target: ResolvedCollection;
}

export interface CollectionArtifact {
  readonly id: ArtifactId;
  clone(ctx: FootprintContext): Promise<void>;
  /**
   * Best-effort teardown of the TARGET artifact (used for create-saga rollback
   * and worktree removal). The orchestrator wraps each call, so an implementation
   * MAY throw; the caller treats a throw as a non-fatal skip. Multi-step removes
   * should still attempt every step internally (swallow per-step) so a single
   * failed step does not abandon the rest of that artifact's cleanup.
   */
  remove(ctx: FootprintContext): Promise<void>;
}
