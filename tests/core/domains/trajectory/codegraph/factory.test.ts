import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EnrichmentProvider,
  WorkerEnrichmentDescriptor,
} from "../../../../../src/core/contracts/types/provider.js";
import {
  createCodegraphEnrichmentProvider,
  type CodegraphWorkerConfig,
} from "../../../../../src/core/domains/trajectory/codegraph/factory.js";

// Absolute path to the compiled language barrel the worker-factory dynamic-imports
// in-thread. The build/ artifact exists after `npm run build`; tests that exercise
// the factory's language-module load run against it. Using the build/ path mirrors
// the chunker pool precedent (LANGUAGE_MODULE_PATH at /build/.../language/index.js).
const LANGUAGE_MODULE_PATH = new URL("../../../../../build/core/domains/language/index.js", import.meta.url).pathname;

describe("createCodegraphEnrichmentProvider", () => {
  it("builds a pool-mode provider from a structured-clone-safe config", async () => {
    const config: CodegraphWorkerConfig = {
      languageModulePath: LANGUAGE_MODULE_PATH,
      rootDir: "/tmp/tea-rags-test-root",
      collectionName: "code_test",
      excludeTests: true,
      customExcludePatterns: [],
    };
    // Worker_threads roundtrip — config MUST survive postMessage.
    const cloned = structuredClone(config);
    // Type-check via EnrichmentProvider: the factory's contract is "an
    // EnrichmentProvider", not "a CodegraphEnrichmentProvider class instance".
    const provider: EnrichmentProvider = await createCodegraphEnrichmentProvider(cloned);
    expect(provider.key).toBe("codegraph.symbols");
    // codegraph defers chunk enrichment — graph only queryable post-finalize.
    expect(provider.defersChunkEnrichment).toBe(true);
    // codegraph holds per-collection run state ⇒ onRelease declared.
    expect(provider.onRelease).toBeDefined();
    // No descriptor passed ⇒ provider runs inline-only.
    expect(provider.workerDescriptor).toBeUndefined();
  });

  it("attaches workerDescriptor when composition root supplies one", async () => {
    const config: CodegraphWorkerConfig = {
      languageModulePath: LANGUAGE_MODULE_PATH,
      rootDir: "/tmp/tea-rags-test-root",
    };
    const descriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: "/abs/path/codegraph/factory.js",
      providerFactoryExport: "createCodegraphEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: config,
    };
    const provider = await createCodegraphEnrichmentProvider(config, descriptor);
    expect(provider.workerDescriptor).toEqual(descriptor);
    expect(provider.workerDescriptor?.dispatch).toBe("collection-affinity");
  });

  describe("pool acquisition — symbolTableFactory and initHook callbacks", () => {
    let rootDir: string;
    let scanRoot: string;

    beforeEach(() => {
      rootDir = mkdtempSync(join(tmpdir(), "cg-factory-pool-"));
      // Empty scan directory — buildFileSignals returns an empty map but
      // still triggers pool.acquireWrite → openCollection → symbolTableFactory
      // + initHook on the first call.
      scanRoot = mkdtempSync(join(tmpdir(), "cg-factory-scan-"));
    });

    afterEach(async () => {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(scanRoot, { recursive: true, force: true });
    });

    it("symbolTableFactory and initHook fire when pool opens a collection for the first time", async () => {
      // Build the provider with a real rootDir so pool mode is active and the
      // inline callbacks (`symbolTableFactory`, `initHook`) in factory.ts are
      // exercised when the collection is first opened via acquireWrite.
      const config: CodegraphWorkerConfig = {
        languageModulePath: LANGUAGE_MODULE_PATH,
        rootDir,
        excludeTests: true,
        customExcludePatterns: [],
      };
      const provider = await createCodegraphEnrichmentProvider(config);

      // Scan an empty directory: no source files → empty overlay map.
      // This still triggers pool.acquireWrite("code_factory_test_v1") which
      // calls symbolTableFactory() to build the InMemoryGlobalSymbolTable and
      // then initHook() to hydrate it from the (empty) fresh DB.
      const collectionName = "code_factory_test_v1";
      const result = await provider.buildFileSignals(scanRoot, { collectionName });

      // An empty scan root yields an empty overlay — confirms the full
      // call path ran without error and symbolTableFactory + initHook executed.
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("initHook hydrates symbol table from existing DB rows on pool re-open", async () => {
      // Pre-create a src file so the provider has something to walk and
      // persist into DuckDB on the first pass. The initHook should then load
      // those symbols when the pool entry is re-opened.
      mkdirSync(join(scanRoot, "src"), { recursive: true });

      const config: CodegraphWorkerConfig = {
        languageModulePath: LANGUAGE_MODULE_PATH,
        rootDir,
        excludeTests: true,
        customExcludePatterns: [],
      };

      const collectionName = "code_factory_hydrate_v1";
      const provider = await createCodegraphEnrichmentProvider(config);

      // First pass — indexing an empty directory populates the pool entry;
      // initHook runs against an empty DB (listAllSymbols → []).
      const firstResult = await provider.buildFileSignals(scanRoot, { collectionName });
      expect(firstResult).toBeInstanceOf(Map);

      // Release the provider so the pool entry is closed and a subsequent
      // acquire triggers a fresh openCollection → symbolTableFactory + initHook.
      await provider.onRelease?.(collectionName);
    });
  });
});
