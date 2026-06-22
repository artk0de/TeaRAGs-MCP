/**
 * bd tea-rags-mcp-svhqp — per-run state isolation on the long-lived daemon-cached
 * provider, exercised through the CROSS-PASS run-start seam (`beginExtractionRun`
 * + `acceptExtraction` + `finalizeSignals({ crossPass })`).
 *
 * The existing `provider-run-stats.test.ts` pins isolation for the
 * `streamFileBatch` entry (which routes through `ensureRunSink` and so resets
 * `runStats`). The cross-pass entry on the full-index path begins a run via
 * `beginExtractionRun` on the MAIN thread — a seam that historically reset only
 * the input spill + dedup set, NOT `runStats`. Exactly one run-start seam must
 * zero ALL per-run state regardless of entry point, otherwise a prior run's
 * tally leaks into the next run's `recordRunStats` on a reused instance and
 * `resolveSuccessRate` jitters run-to-run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

const DIRECT_INPUT_SPILL = join(process.cwd(), ".tea-rags-codegraph-spill", "xpass-__direct__.ndjson");

// Foo.bar resolves (target in symbol table); Mystery.nope does not → both land
// in the `constant` bucket, 1 of 2 resolved. Mirrors the makeRoot fixture in
// provider-run-stats.test.ts but as a pre-built FileExtraction fed via the
// cross-pass `acceptExtraction` channel (no on-disk source, no parse).
function fooExtraction(): FileExtraction {
  return {
    relPath: "src/foo.ts",
    language: "typescript",
    imports: [],
    fileScope: ["Foo"],
    chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [], startLine: 1, endLine: 3 }],
  };
}

function mainExtraction(): FileExtraction {
  return {
    relPath: "src/main.ts",
    language: "typescript",
    imports: [{ importText: "./foo.js", startLine: 1 }],
    fileScope: ["main"],
    chunks: [
      {
        symbolId: "main",
        scope: [],
        startLine: 2,
        endLine: 5,
        calls: [
          { callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 3 },
          { callText: "Mystery.nope()", receiver: "Mystery", member: "nope", startLine: 4 },
        ],
      },
    ],
  };
}

// Unique per-cycle collection ⇒ a private input-spill path, isolating this test
// from other direct-mode cross-pass tests sharing the cwd spill dir. In direct
// mode collectionName only routes the spill path; the single injected graphDb is
// used regardless.
async function runCrossPassCycle(
  provider: CodegraphEnrichmentProvider,
  root: string,
  collectionName: string,
): Promise<void> {
  provider.beginExtractionRun(collectionName);
  provider.acceptExtraction(fooExtraction(), { collectionName });
  provider.acceptExtraction(mainExtraction(), { collectionName });
  await provider.streamFileBatch(root, ["src/foo.ts", "src/main.ts"], { crossPass: true, collectionName });
  await provider.finalizeSignals(root, {
    crossPass: true,
    paths: ["src/foo.ts", "src/main.ts"],
    collectionName,
  });
}

describe("CodegraphEnrichmentProvider — cross-pass run-stats isolation (svhqp)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-xpass-runstats-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    rmSync(DIRECT_INPUT_SPILL, { force: true });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(DIRECT_INPUT_SPILL, { force: true });
  });

  it("two cross-pass cycles on a reused instance persist ONLY the second run's counts", async () => {
    await runCrossPassCycle(provider, tmp, "svhqp_cycle_a");
    const after1 = (await client.getRunStats()).find((r) => r.receiverKind === "constant");
    expect(after1).toMatchObject({ attempted: 2, resolved: 1 });

    // Second cross-pass cycle on the SAME instance, getRunMetrics NOT called
    // between runs (daemon completion-runner timing). Without a runStats reset at
    // the beginExtractionRun seam the tally accumulates → attempted: 4.
    await runCrossPassCycle(provider, tmp, "svhqp_cycle_b");
    const after2 = (await client.getRunStats()).find((r) => r.receiverKind === "constant");
    expect(after2).toMatchObject({ attempted: 2, resolved: 1 });
  });

  it("beginExtractionRun zeroes runStats so getRunMetrics with no extraction returns undefined", async () => {
    // Seed a prior run's tally, then DO NOT read-and-clear via getRunMetrics
    // (simulate a daemon whose completion-runner has not fired).
    await runCrossPassCycle(provider, tmp, "svhqp_seed");

    // A fresh run starts but no file is fed. beginExtractionRun must zero the
    // leaked tally so getRunMetrics reports the empty run as empty.
    provider.beginExtractionRun("svhqp_empty");
    expect(provider.getRunMetrics()).toBeUndefined();
  });
});
