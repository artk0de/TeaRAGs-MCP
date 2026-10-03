/**
 * WorkingTreeGraphCache end to end (bd tea-rags-mcp-xi2r9, WTO-7 T12): a real
 * direct-mode pool over an indexed fixture project exports the base snapshot,
 * the real `WorkingTreeGraphProcessBuilder` forks the COMPILED entry (needs
 * `npm run build`), and `graphFor` answers with a published graph whose edges
 * are the tree's, not the base's.
 */
import { dirname } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { WorkingTreeGraphCache } from "../../../../../src/core/api/internal/infra/working-tree-graph-cache.js";
import { createCodegraphProviderRuntime } from "../../../../../src/core/domains/trajectory/codegraph/factory.js";
import { WorkingTreeGraphProcessBuilder } from "../../../../../src/core/domains/trajectory/codegraph/working-tree/index.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  methodEdges,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
} from "../../../domains/trajectory/codegraph/working-tree/__helpers__/tree-graph-fixture.js";

afterAll(() => {
  cleanupTreeGraphFixtures();
});

const BASE = {
  "src/x.ts": `export function x(): number {\n  return 1;\n}\n\nexport function y(): number {\n  return 2;\n}\n`,
  "src/a.ts": `import { x } from "./x";\n\nexport function run(): number {\n  return x();\n}\n`,
};
const A_TREE = `import { y } from "./x";\n\nexport function run(): number {\n  return y();\n}\n`;

describe("WorkingTreeGraphCache with the real builder and a direct-mode pool", () => {
  it("graphFor returns a built graph whose edges reflect the working tree", async () => {
    const fixture = await buildTreeGraphFixture(BASE);
    fixture.writeTree("src/a.ts", A_TREE);
    // The fixture's base graph sits at `<storageRoot>/codegraph/<physical>.duckdb`.
    const storageRoot = dirname(dirname(fixture.snapshotPath));
    const { pool } = await createCodegraphProviderRuntime({
      languageModulePath: LANGUAGE_MODULE_PATH,
      migrationsModulePath: MIGRATIONS_MODULE_PATH,
      rootDir: storageRoot,
      collectionName: PHYSICAL,
    });
    try {
      const cache = new WorkingTreeGraphCache({
        rootDir: fixture.outputRoot,
        codegraph: () => ({
          pool,
          providerConfig: { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH },
        }),
        resolveActiveCollection: async () => PHYSICAL,
        builder: new WorkingTreeGraphProcessBuilder(),
        budget: { timeoutMs: 60_000, heapLimitMb: 1024 },
      });

      const state = await cache.graphFor(
        {
          tree: { root: fixture.treeRoot, baseIndex: { collectionName: "code_wtgraph", root: fixture.baseRoot } },
          changed: ["src/a.ts"],
          deleted: [],
          fingerprint: "fp-a",
        },
        60_000,
      );

      expect(state).toMatchObject({ kind: "built", physicalCollectionName: PHYSICAL });
      if (state.kind !== "built") return;
      const edges = await methodEdges(state.dbPath);
      expect(edges).toContain("src/a.ts#run -> src/x.ts#y");
      expect(edges).not.toContain("src/a.ts#run -> src/x.ts#x");
      // The base graph is untouched: the tree's edits live only in the tree graph.
      expect(await methodEdges(pool.pathFor(PHYSICAL))).toContain("src/a.ts#run -> src/x.ts#x");
    } finally {
      await pool.closeAll();
    }
  }, 120_000);
});
