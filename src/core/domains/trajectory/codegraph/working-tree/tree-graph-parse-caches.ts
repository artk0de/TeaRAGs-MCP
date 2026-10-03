/**
 * The warm tree-graph child's per-TREE language parse caches. Consecutive
 * builds of one tree re-parse almost nothing new — the edit moves a handful of
 * files while the default lib, the dependency `.d.ts` surface and the rest of
 * the project stay put — so each tree keeps the cache its last build filled,
 * and the next build of that tree parses through it.
 *
 * Keyed by tree root and language module: the module is what builds the cache
 * and reads it. What a parse further depends on (compiler options, the file's
 * stamp) is checked per read by the cache itself, so a tsconfig or file edited
 * between two builds never reaches the second as the first's parse. Only the
 * most recently built trees keep theirs: a cache holds parsed ASTs, and the
 * child's heap ceiling is one build's, not one per tree ever seen.
 */
import type { LanguageCrossRunParseCache } from "../../../../contracts/types/language.js";
import { createLanguageCrossRunParseCache } from "../factory.js";
import type { WorkingTreeGraphBuildInput } from "./tree-graph-build.js";

/** Trees whose caches the child keeps by default — the tree being edited and one it switches back from. */
export const TREE_GRAPH_PARSE_CACHE_TREES_DEFAULT = 2;

export class TreeGraphParseCacheRegistry {
  /** Insertion-ordered LRU — the first key is the least recently built tree. */
  private readonly caches = new Map<string, LanguageCrossRunParseCache>();
  private readonly maxTrees: number;

  constructor(options: { maxTrees?: number } = {}) {
    this.maxTrees = options.maxTrees ?? TREE_GRAPH_PARSE_CACHE_TREES_DEFAULT;
  }

  /** The cache the build of `input.treeRoot` parses through — the one its previous build filled, or a fresh one. */
  async cacheFor(
    input: Pick<WorkingTreeGraphBuildInput, "treeRoot" | "providerConfig">,
  ): Promise<LanguageCrossRunParseCache> {
    const key = `${input.providerConfig.languageModulePath}\0${input.treeRoot}`;
    const held = this.caches.get(key);
    if (held) {
      this.caches.delete(key);
      this.caches.set(key, held);
      return held;
    }
    const created = await createLanguageCrossRunParseCache(input.providerConfig.languageModulePath);
    this.caches.set(key, created);
    for (const oldest of this.caches.keys()) {
      if (this.caches.size <= this.maxTrees) break;
      this.caches.delete(oldest);
    }
    return created;
  }
}
