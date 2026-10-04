/**
 * The warm tree-graph child keeps the language's cross-run parse cache per
 * TREE: consecutive builds of one tree reuse it, a build of another tree gets
 * its own, and only the most recently built trees keep theirs.
 */
import { describe, expect, it } from "vitest";

import {
  TREE_GRAPH_PARSE_CACHE_TREES_DEFAULT,
  TreeGraphParseCacheRegistry,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-parse-caches.js";
import { LANGUAGE_MODULE_PATH, MIGRATIONS_MODULE_PATH } from "./__helpers__/tree-graph-fixture.js";

const providerConfig = { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH };

describe("TreeGraphParseCacheRegistry", () => {
  it("hands consecutive builds of one tree the same cache", async () => {
    const registry = new TreeGraphParseCacheRegistry();

    const first = await registry.cacheFor({ treeRoot: "/trees/one", providerConfig });
    const second = await registry.cacheFor({ treeRoot: "/trees/one", providerConfig });

    expect(second).toBe(first);
  });

  it("hands a build of another tree its own cache", async () => {
    const registry = new TreeGraphParseCacheRegistry();

    const one = await registry.cacheFor({ treeRoot: "/trees/one", providerConfig });
    const two = await registry.cacheFor({ treeRoot: "/trees/two", providerConfig });

    expect(two).not.toBe(one);
    expect(await registry.cacheFor({ treeRoot: "/trees/one", providerConfig })).toBe(one);
  });

  it("keeps the caches of the most recently built trees only", async () => {
    const registry = new TreeGraphParseCacheRegistry({ maxTrees: 1 });

    const one = await registry.cacheFor({ treeRoot: "/trees/one", providerConfig });
    await registry.cacheFor({ treeRoot: "/trees/two", providerConfig });

    expect(await registry.cacheFor({ treeRoot: "/trees/one", providerConfig })).not.toBe(one);
  });

  it("a fresh cache reports nothing reused and nothing parsed", async () => {
    const cache = await new TreeGraphParseCacheRegistry().cacheFor({ treeRoot: "/trees/one", providerConfig });

    expect(cache.usage()).toEqual({ reused: 0, parsed: 0, retainedFiles: 0, retainedTextBytes: 0 });
  });

  it("keeps two trees by default", () => {
    expect(TREE_GRAPH_PARSE_CACHE_TREES_DEFAULT).toBe(2);
  });
});
