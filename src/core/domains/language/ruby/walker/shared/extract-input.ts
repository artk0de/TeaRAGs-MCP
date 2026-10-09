import type { MaterializedTree } from "../../../../../contracts/types/ast.js";

export interface RubyExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
  /**
   * The root `Gemfile`'s gems for the run (mirrors `WalkInput.declaredDependencies`).
   * Extraction consumers gate DSL grammar on it via `catalogueFor`;
   * undefined → FULL catalogue (bd tea-rags-mcp-adx5p.1b, m99j1.1.8).
   */
  declaredDependencies?: ReadonlySet<string>;
}
