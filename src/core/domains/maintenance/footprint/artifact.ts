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
  remove(ctx: FootprintContext): Promise<void>;
}
