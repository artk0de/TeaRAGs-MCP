/**
 * The cross-pass input spill lives for one run: the main thread appends to it
 * during embedding and the worker's finalize drains and unlinks it. It is named
 * after the PHYSICAL generation, so a run that never reached the drain left it
 * where no later run truncates it once the alias moves on — `.xpass` grew one
 * full-corpus NDJSON per abandoned generation. `discardExtractionRun` is the
 * run-end seam the coordinator calls on every completion path.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

function extraction(relPath: string): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: ["Alpha"],
    chunks: [{ symbolId: "Alpha#one", scope: ["Alpha"], calls: [], startLine: 1, endLine: 3 }],
  };
}

describe("CodegraphEnrichmentProvider#discardExtractionRun", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function makeProvider(): Promise<CodegraphEnrichmentProvider> {
    const tmp = mkdtempSync(join(tmpdir(), "cg-xpass-discard-"));
    const client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    cleanups.push(async () => {
      await client.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    return new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  }

  function spillPathOf(provider: CodegraphEnrichmentProvider, collectionName: string): string {
    return (provider as unknown as { inputSpillPath: (name: string) => string }).inputSpillPath(collectionName);
  }

  it("deletes a spill the run wrote but never drained", async () => {
    const provider = await makeProvider();
    const collectionName = fixturePhysicalCollectionName(`xpass_${randomUUID().replace(/-/g, "")}`);
    const spill = spillPathOf(provider, collectionName);
    cleanups.push(async () => {
      rmSync(spill, { force: true });
    });

    provider.beginExtractionRun(collectionName);
    provider.acceptExtraction(extraction("a_alpha.rb"), { collectionName });
    expect(existsSync(spill)).toBe(true);

    provider.discardExtractionRun(collectionName);

    expect(existsSync(spill)).toBe(false);
  });

  it("is a no-op when the spill is already gone", async () => {
    const provider = await makeProvider();
    const collectionName = fixturePhysicalCollectionName(`xpass_${randomUUID().replace(/-/g, "")}`);

    expect(() => {
      provider.discardExtractionRun(collectionName);
    }).not.toThrow();
    expect(existsSync(spillPathOf(provider, collectionName))).toBe(false);
  });

  it("leaves another generation's spill in place", async () => {
    const provider = await makeProvider();
    const kept = fixturePhysicalCollectionName(`xpass_${randomUUID().replace(/-/g, "")}`);
    const discarded = fixturePhysicalCollectionName(`xpass_${randomUUID().replace(/-/g, "")}`);
    const keptSpill = spillPathOf(provider, kept);
    cleanups.push(async () => {
      rmSync(keptSpill, { force: true });
    });

    provider.beginExtractionRun(kept);
    provider.acceptExtraction(extraction("a_alpha.rb"), { collectionName: kept });
    provider.discardExtractionRun(discarded);

    expect(existsSync(keptSpill)).toBe(true);
  });
});
