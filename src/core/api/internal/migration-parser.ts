import { TreeSitterChunker } from "../../domains/ingest/pipeline/chunker/tree-sitter.js";
import { chunkRailsMigration, DefaultSymbolIdComposer, LanguageFactory } from "../../domains/language/index.js";

export async function parseMigrationOperations(code: string, filePath: string, chunkSize: number) {
  const languageFactory = new LanguageFactory();
  // Ruby only — preload exactly what this parser chunks (bd tea-rags-mcp-zkd96).
  await languageFactory.preload(["ruby"]);
  const parser = new TreeSitterChunker(
    { chunkSize, chunkOverlap: 0, maxChunkSize: chunkSize },
    new DefaultSymbolIdComposer(),
    languageFactory,
  );
  const { tree } = await parser.chunkWithTree(code, filePath, "ruby");
  if (!tree) throw new Error(`Cannot parse migration: ${filePath}`);
  return chunkRailsMigration(tree.rootNode, code, filePath);
}
