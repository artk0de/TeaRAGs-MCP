/**
 * The rust-analyzer SCIP slot end to end (bd s3i8m.6 R3a): the mini fixture,
 * its committed index through the real decoder, the real Rust walker and a
 * direct-mode codegraph run. `Gauge#bump` makes every `bump` call ambiguous by
 * name, so `main`'s `counter.bump(2)` and `via_closure`'s `made.bump(1)` (a
 * closure-result receiver no name pass types) land on `Counter#bump` only
 * through the SCIP slot. The walker's member position also survives the
 * extraction spill, which is plain NDJSON.
 *
 * Fixture regenerated (no-exec, appended `via_closure` and `Gauge` so every
 * earlier position is unchanged) with
 * `rust-analyzer scip tests/fixtures/rust-analyzer-scip/mini --config-path <no-exec.json>
 *  --exclude-vendored-libraries --output tests/fixtures/rust-analyzer-scip/mini/index.scip`,
 * config `{"cargo":{"buildScripts":{"enable":false,"overrideCommand":["/usr/bin/true"]}},"procMacro":{"enable":false}}`.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import {
  createRustAnalyzerScipIndex,
  decodeRustAnalyzerScip,
} from "../../../../../../src/core/adapters/rust-analyzer/index.js";
import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphExtractionSpillWriter } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/extraction-spill-writer.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const MIG_DIR = join(
  import.meta.dirname,
  "../../../../../../src/core/domains/maintenance/migration/database/migrations",
);
const FIXTURE = join(import.meta.dirname, "../../../../../fixtures/rust-analyzer-scip/mini");
const FILES = ["src/main.rs", "src/shape.rs"];

describe("rust-analyzer SCIP as the last Rust strategy through a codegraph run (bd s3i8m.6 R3a)", () => {
  let tmp: string;
  const clients: DuckDbGraphClient[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ra-scip-resolve-"));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function calleesOf(withScip: boolean, dbName: string) {
    const root = join(tmp, dbName, "mini");
    cpSync(FIXTURE, root, { recursive: true });
    const client = new DuckDbGraphClient({ path: join(tmp, `${dbName}.duckdb`) });
    clients.push(client);
    await client.init();
    await runMigrations(client, MIG_DIR);
    const index = createRustAnalyzerScipIndex(
      decodeRustAnalyzerScip(readFileSync(join(FIXTURE, "index.scip"))),
      "mini",
    );
    const languageFactory = new LanguageFactory(
      withScip
        ? {
            rustAnalyzerScipSource: {
              acquire: async () => ({ kind: "indexed", index, cacheHit: true, toolchainSkew: false }),
            },
          }
        : {},
    );
    const provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      languageFactory,
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    await provider.streamFileBatch(root, FILES);
    await provider.finalizeSignals(root, { runCoverage: "wholeCorpus" });
    const targets = async (caller: string) =>
      (await client.getCallees(caller)).map((edge) => `${edge.callExpression} -> ${edge.targetSymbolId}`);
    return { main: await targets("main"), viaClosure: await targets("via_closure"), extras: await targets("extras") };
  }

  it("lands the name-ambiguous calls on Counter#bump through the SCIP slot only", async () => {
    const without = await calleesOf(false, "off");
    const withScip = await calleesOf(true, "on");

    expect(without.main).toEqual([]);
    expect(without.viaClosure).toEqual([]);
    expect(withScip.main).toEqual(["counter.bump(2) -> Counter#bump"]);
    expect(withScip.viaClosure).toEqual(["made.bump(1) -> Counter#bump"]);
    // Additive: every edge the name passes found is still there.
    expect(withScip.extras).toEqual(without.extras);
  });

  it("keeps the member position through the extraction spill", async () => {
    const spillPath = join(tmp, "spill.ndjson");
    const writer = new CodegraphExtractionSpillWriter<{ calls: CallRef[] }>(spillPath);
    const call: CallRef = {
      callText: "made.bump(1)",
      receiver: "made",
      member: "bump",
      startLine: 33,
      startColumn: 4,
      memberStartLine: 33,
      memberStartColumn: 9,
    };
    await writer.append({ calls: [call] });
    await writer.close();

    const [row] = readFileSync(spillPath, "utf8").trim().split("\n");
    expect(JSON.parse(row).calls[0]).toMatchObject({ memberStartLine: 33, memberStartColumn: 9 });
  });
});
