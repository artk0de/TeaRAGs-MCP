import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import { CharacterChunker } from "./chunker/character.js";
import { discoverMigrationFiles, migrationCollectionName } from "./migration-files.js";

interface MigrationCorpusStore {
  createCollection: (name: string, dimensions: number, distance: "Cosine", sparse: boolean) => Promise<void>;
  collectionExists: (name: string) => Promise<boolean>;
  getPoint?: (name: string, id: string) => Promise<{ payload?: Record<string, unknown> } | null>;
  deleteCollection: (name: string) => Promise<void>;
  deletePointsByPaths?: (name: string, paths: string[]) => Promise<void>;
  addPointsWithSparse: (
    name: string,
    points: {
      id: string;
      vector: number[];
      sparseVector: ReturnType<typeof generateSparseVector>;
      payload: Record<string, unknown>;
    }[],
  ) => Promise<void>;
  aliases: {
    createAlias: (alias: string, collection: string) => Promise<void>;
    switchAlias: (alias: string, from: string, to: string) => Promise<void>;
    resolveActive?: (alias: string) => Promise<string>;
  };
}

interface MigrationEmbeddings {
  getDimensions: () => number;
  getModel?: () => string;
  embed?: (text: string) => Promise<{ embedding: number[] }>;
  embedBatch: (texts: string[]) => Promise<{ embedding: number[] }[]>;
}

export interface MigrationOperation {
  content: string;
  startLine: number;
  endLine: number;
  symbolId: string;
  chunkType: "migration";
  operation: string;
  version?: string;
  direction?: string;
  table?: string;
  columns: string[];
}

export type MigrationParser = (code: string, filePath: string, chunkSize: number) => Promise<MigrationOperation[]>;

export async function rebuildMigrationCorpus(options: {
  root: string;
  codeCollection: string;
  qdrant: MigrationCorpusStore;
  embeddings: MigrationEmbeddings;
  chunkSize?: number;
  parse: MigrationParser;
  synchronizer?: {
    initialize: () => Promise<boolean>;
    detectChanges: (files: string[]) => Promise<{ added: string[]; modified: string[]; deleted: string[] }>;
    invalidateEntries: (paths: Iterable<string>) => Promise<number>;
    updateSnapshot: (files: string[]) => Promise<void>;
  };
}): Promise<void> {
  const { root, codeCollection, qdrant, embeddings } = options;
  const chunkSize = options.chunkSize ?? 4500;
  const files = await discoverMigrationFiles(root);
  const alias = migrationCollectionName(codeCollection);
  const previous = (await qdrant.collectionExists(alias)) ? await qdrant.aliases.resolveActive?.(alias) : undefined;
  if (files.length === 0 && !previous) return;
  const { synchronizer } = options;
  const hasSnapshot = synchronizer ? await synchronizer.initialize() : false;
  const metadata = previous ? (await qdrant.getPoint?.(previous, INDEXING_METADATA_ID))?.payload : undefined;
  const migrationConfig = JSON.stringify(["migration-v2", chunkSize, embeddings.getModel?.()]);
  const incremental = !!previous && hasSnapshot && metadata?.migrationConfig === migrationConfig;
  const changes = incremental && synchronizer ? await synchronizer.detectChanges(files) : undefined;
  if (changes && changes.added.length + changes.modified.length + changes.deleted.length === 0) return;
  if (changes && synchronizer) await synchronizer.invalidateEntries([...changes.modified, ...changes.deleted]);
  if (changes && !qdrant.deletePointsByPaths) throw new Error("Migration corpus requires path deletion support");
  const filesToEmbed = changes ? [...changes.added, ...changes.modified].map((file) => join(root, file)) : files;
  const sourceFiles = await Promise.all(
    filesToEmbed.map(async (filePath) => ({ filePath, code: await readFile(filePath, "utf8") })),
  );
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "migration-v2",
        chunkSize,
        embeddings.getModel?.(),
        sourceFiles.map(({ filePath, code }) => [relative(root, filePath), code]),
      ]),
    )
    .digest("hex");
  if (!synchronizer && previous && metadata?.migrationDigest === digest) {
    return;
  }
  const target = incremental ? previous : `${alias}_${randomUUID().replaceAll("-", "")}`;
  const probe = incremental ? undefined : await embeddings.embed?.("tea-rags vector width probe");
  const dimensions = probe?.embedding.length || embeddings.getDimensions();
  if (!incremental) await qdrant.createCollection(target, dimensions, "Cosine", true);
  let published = incremental;
  try {
    if (changes?.deleted.length && qdrant.deletePointsByPaths) {
      await qdrant.deletePointsByPaths(target, changes.deleted);
    }
    for (const { filePath, code } of sourceFiles) {
      const relativePath = relative(root, filePath).split(sep).join("/");
      const operations = await options.parse(code, relativePath, chunkSize);
      if (operations.length === 0 && code.trim()) {
        operations.push({
          content: code,
          startLine: 1,
          endLine: code.split("\n").length,
          symbolId: `migration:${relativePath}:source:1`,
          chunkType: "migration",
          operation: "source",
          columns: [],
        });
      }
      const chunks = [];
      for (const operation of operations) {
        if (operation.content.length <= chunkSize) {
          chunks.push(operation);
          continue;
        }
        const header = operation.content.split("\n")[0];
        const prefix = header.length + 1 < chunkSize ? `${header}\n` : "";
        const budget = chunkSize - prefix.length;
        const splitter = new CharacterChunker({ chunkSize: budget, chunkOverlap: 0, maxChunkSize: budget });
        const parts = await splitter.chunk(operation.content, filePath, "ruby");
        chunks.push(
          ...parts.map((part, index) => ({
            ...operation,
            content: index === 0 ? part.content : prefix + part.content,
            startLine: operation.startLine + part.startLine - 1,
            endLine: operation.startLine + part.endLine - 1,
            symbolId: `${operation.symbolId}#part${index + 1}`,
          })),
        );
      }
      if (chunks.length === 0) {
        if (incremental && qdrant.deletePointsByPaths) await qdrant.deletePointsByPaths(target, [relativePath]);
        continue;
      }
      const vectors = await embeddings.embedBatch(chunks.map((chunk) => chunk.content));
      const points = chunks.map((chunk, index) => {
        const hash = createHash("sha256").update(`${relativePath}:${chunk.symbolId}:${chunk.content}`).digest("hex");
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        return {
          id,
          vector: vectors[index].embedding,
          sparseVector: generateSparseVector(chunk.content),
          payload: {
            ...chunk,
            relativePath,
            language: "ruby",
            fileExtension: ".rb",
            codebasePath: root,
            chunkIndex: index,
          },
        };
      });
      if (incremental && qdrant.deletePointsByPaths) await qdrant.deletePointsByPaths(target, [relativePath]);
      await qdrant.addPointsWithSparse(target, points);
    }
    if (!incremental) {
      await qdrant.addPointsWithSparse(target, [
        {
          id: INDEXING_METADATA_ID,
          vector: new Array<number>(dimensions).fill(0),
          sparseVector: { indices: [], values: [] },
          payload: {
            _type: "indexing_metadata",
            indexingComplete: true,
            embeddingModel: embeddings.getModel?.(),
            migrationDigest: digest,
            migrationConfig,
          },
        },
      ]);
    }
    if (!incremental) {
      if (previous) await qdrant.aliases.switchAlias(alias, previous, target);
      else await qdrant.aliases.createAlias(alias, target);
      published = true;
      if (previous) await qdrant.deleteCollection(previous);
    }
    await synchronizer?.updateSnapshot(files);
  } finally {
    if (!published) await qdrant.deleteCollection(target);
  }
}
