/**
 * The chunker-owned point rows ingest stores for one source file (bd
 * tea-rags-mcp-xi2r9.3): ids from `generateChunkId` mapped to the id the point
 * is STORED under (`toQdrantPointId`, the mapping `QdrantPointStore` applies
 * on every write), payload from
 * `buildChunkPointPayload`, chunks from the production `ChunkerPool` with the
 * same post-passes `SourceFileIngestor#ingest` runs. A reader that must see a
 * file exactly as ingest would store it — without embedding or upserting it —
 * calls this; the working-tree overlay is that reader.
 *
 * Rows carry no git or codegraph payload: enrichment writes those later.
 *
 * Why the stored id and not `chunk_<hex>` (bd tea-rags-mcp-xi2r9, live probe):
 * a reader hands these ids out beside base rows, and a caller passes them back
 * — `find_similar positiveIds`. A `chunk_` id addressed no point and drew a 400
 * Bad Request; the stored id is the one an indexed twin of the row carries, so
 * an unchanged chunk of a changed file (same root, same lines, same content)
 * answers with its base point's id.
 */

import { join } from "node:path";

import { toQdrantPointId } from "../../../adapters/qdrant/point-id.js";
import type { PayloadBuilder } from "../../../contracts/types/provider.js";
import { isCompiledJsContent, isJsFamilyPath } from "../../../infra/file-classification/index.js";
import { isTestPath } from "../../../infra/scope-detection.js";
import { buildChunkPointPayload } from "./chunk-point-payload.js";
import { assignNavigationAndDocSymbolId } from "./chunker/chunk-navigation.js";
import type { ChunkerPoolPort } from "./chunker/infra/pool.js";
import { assignSymbolMass } from "./chunker/symbol-mass.js";
import { generateChunkId } from "./chunker/utils/chunk-id.js";
import { extractImportsExports } from "./chunker/utils/import-extractor.js";
import { detectLanguage } from "./chunker/utils/language-detector.js";
import { containsSecrets } from "./chunker/utils/secrets-detector.js";

/** Why ingest refuses a file on its CONTENT, before parsing it. */
export type SourceContentSkipReason = "secrets" | "compiled";

/**
 * The content gates ingest applies before parse, cheapest first:
 * credential-looking content outside tests, and a compiled JS bundle that
 * slipped past the scanner's path ignore (9oq5e Layer 2 — JS family only,
 * gated on extension so `.mjs`/`.cjs` are covered).
 */
export function sourceContentSkipReason(
  filePath: string,
  relativePath: string,
  code: string,
  language: string,
): SourceContentSkipReason | undefined {
  if (!isTestPath(relativePath, language) && containsSecrets(code)) return "secrets";
  if (isJsFamilyPath(filePath) && isCompiledJsContent(code)) return "compiled";
  return undefined;
}

export interface FileChunkPointsInput {
  /** Tree root — the `codebasePath` the payload is relative to. */
  root: string;
  relativePath: string;
  code: string;
}

export interface FileChunkPoint {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * One file's point rows as ingest would store them. A file ingest skips on
 * content yields none. A parse failure rejects — the caller decides what an
 * unparsable file means.
 */
export async function buildFileChunkPoints(
  pool: Pick<ChunkerPoolPort, "processFile">,
  file: FileChunkPointsInput,
  payloadBuilder: PayloadBuilder,
): Promise<FileChunkPoint[]> {
  const { root, relativePath, code } = file;
  const filePath = join(root, relativePath);
  const language = detectLanguage(filePath);
  if (sourceContentSkipReason(filePath, relativePath, code, language)) return [];

  const { chunks, imports: astImports } = await pool.processFile(filePath, code, language, false);
  const imports = astImports ?? extractImportsExports(code, language).imports;
  assignNavigationAndDocSymbolId(chunks, root);
  assignSymbolMass(chunks, code);
  return chunks.map((chunk) => ({
    id: String(toQdrantPointId(generateChunkId(chunk))),
    payload: buildChunkPointPayload(chunk, { codebasePath: root, imports, payloadBuilder }),
  }));
}
