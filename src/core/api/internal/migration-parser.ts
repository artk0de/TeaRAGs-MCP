import { TreeSitterChunker } from "../../domains/ingest/pipeline/chunker/tree-sitter.js";
import { chunkRailsMigration, DefaultSymbolIdComposer, LanguageFactory } from "../../domains/language/index.js";

export async function parseMigrationOperations(code: string, filePath: string, chunkSize: number) {
  const parser = new TreeSitterChunker(
    { chunkSize, chunkOverlap: 0, maxChunkSize: chunkSize },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
  const { tree } = await parser.chunkWithTree(code, filePath, "ruby");
  if (!tree) throw new Error(`Cannot parse migration: ${filePath}`);
  return chunkRailsMigration(tree.rootNode, code, filePath);
}
