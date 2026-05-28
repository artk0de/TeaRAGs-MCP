/**
 * Phase 2 Task 3c — codegraph provider workerDescriptor + onRelease contract.
 *
 * Worker-rebuild factory itself lives in Task 4 (the worker entry that
 * dynamic-imports the language module and opens the daemon socket). This
 * suite locks down the data-only contract that Task 4 depends on:
 *   - CodegraphWorkerConfig is structured-clone-safe (worker_threads
 *     transport invariant)
 *   - CodegraphEnrichmentProvider exposes the workerDescriptor when the
 *     composition root supplies one
 *   - onRelease is callable (worker calls it on releaseCollection signal)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { CallResolver } from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  EnrichmentProvider,
  WorkerEnrichmentDescriptor,
} from "../../../../../../src/core/contracts/types/provider.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import type { CodegraphWorkerConfig } from "../../../../../../src/core/domains/trajectory/codegraph/factory.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirnameSafe = new URL(".", import.meta.url).pathname;
const MIG_DIR = join(__dirnameSafe, "../../../../../../src/core/infra/migration/database/migrations");

describe("CodegraphEnrichmentProvider — worker integration contract", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-worker-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });
  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildProvider(descriptor?: WorkerEnrichmentDescriptor): CodegraphEnrichmentProvider {
    return new CodegraphEnrichmentProvider(
      {
        graphDb: client,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(
          new Map<string, CallResolver>([
            ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
            ["javascript", new JavascriptCallResolver()],
          ]),
        ),
        composer: new DefaultSymbolIdComposer(),
      },
      descriptor,
    );
  }

  it("CodegraphWorkerConfig is structured-clone-safe (worker_threads transport)", () => {
    const config: CodegraphWorkerConfig = {
      languageModulePath: "/abs/path/to/language-module.js",
      daemonSocketPath: "/tmp/tea-rags-codegraph.sock",
      collectionName: "code_8b243ffe",
      excludeTests: true,
      customExcludePatterns: ["**/fixtures/**"],
    };
    expect(structuredClone(config)).toEqual(config);
  });

  it("exposes workerDescriptor when composition root supplies one", () => {
    const config: CodegraphWorkerConfig = {
      languageModulePath: "/abs/path/lang.js",
      daemonSocketPath: "/tmp/daemon.sock",
      collectionName: "code_xxx",
    };
    const descriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: "/abs/path/codegraph-factory.js",
      providerFactoryExport: "createCodegraphEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: config,
    };
    const provider: EnrichmentProvider = buildProvider(descriptor);
    expect(provider.workerDescriptor).toEqual(descriptor);
    expect(provider.workerDescriptor?.dispatch).toBe("collection-affinity");
  });

  it("omits workerDescriptor when constructed without one (inline-only)", () => {
    const provider: EnrichmentProvider = buildProvider();
    expect(provider.workerDescriptor).toBeUndefined();
  });

  it("exposes onRelease as the per-collection state release hook", async () => {
    const provider: EnrichmentProvider = buildProvider();
    // The hook itself must exist on codegraph (unlike git which omits it).
    expect(typeof provider.onRelease).toBe("function");
    // Idempotent: calling it on a fresh provider with no accumulated state
    // is a no-op, not an error — the worker may emit release after a
    // finalize that already cleared most of the state.
    await expect(provider.onRelease!()).resolves.toBeUndefined();
    // Repeat call is also safe.
    await expect(provider.onRelease!()).resolves.toBeUndefined();
  });
});
