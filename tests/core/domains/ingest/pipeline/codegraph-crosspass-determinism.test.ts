/**
 * bd tea-rags-mcp-yl9tv — deterministic cross-pass resolve order.
 *
 * The set + ORDER of files draining through pass-1/pass-2 at the cross-pass
 * `drainInputSpill` seam must be reproducible run-to-run. The input spill is
 * appended in file-COMPLETION order under `fileConcurrency`, which is
 * non-deterministic. Several run-global last-write-wins merges (`runAncestors`,
 * `runReturnTypes`, `runDispatchTables`, …) are order-sensitive, so a varying
 * drain order makes resolution outcome — and `resolveSuccessRate` — jitter.
 *
 * Fix: `drainInputSpill` SORTS the spilled extractions by relPath before
 * resolving, so the drain order (and every order-dependent merge) is identical
 * regardless of the order the chunk pass happened to spill them in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";
import { buildTestCodegraphDeps } from "../../trajectory/codegraph/__helpers__/language-factory.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../src/core/infra/migration/database/migrations");
const DIRECT_INPUT_SPILL = join(process.cwd(), ".tea-rags-codegraph-spill", "xpass-__direct__.ndjson");

// A small multi-file project: several normal TS files with cross-file calls,
// plus a markdown file (no graph) and a "broken"/marginal file. Each is a
// pre-built FileExtraction (the cross-pass channel takes extractions, not
// source) so we can control the spill line order precisely.
function fixtureExtractions(): FileExtraction[] {
  return [
    {
      relPath: "src/util.ts",
      language: "typescript",
      imports: [],
      fileScope: ["Util"],
      chunks: [{ symbolId: "Util.run", scope: ["Util"], calls: [], startLine: 1, endLine: 3 }],
    },
    {
      relPath: "src/svc.ts",
      language: "typescript",
      imports: [{ importText: "./util.js", startLine: 1 }],
      fileScope: ["Svc"],
      chunks: [
        {
          symbolId: "Svc.go",
          scope: ["Svc"],
          startLine: 2,
          endLine: 6,
          calls: [
            { callText: "Util.run()", receiver: "Util", member: "run", startLine: 3 },
            { callText: "Ghost.gone()", receiver: "Ghost", member: "gone", startLine: 4 },
          ],
        },
      ],
    },
    {
      relPath: "src/app.ts",
      language: "typescript",
      imports: [{ importText: "./svc.js", startLine: 1 }],
      fileScope: ["App"],
      chunks: [
        {
          symbolId: "App.main",
          scope: ["App"],
          startLine: 2,
          endLine: 5,
          calls: [{ callText: "Svc.go()", receiver: "Svc", member: "go", startLine: 3 }],
        },
      ],
    },
    // Markdown — no graph; provider has no walker → produces no overlay/edges.
    { relPath: "README.md", language: "markdown", imports: [], fileScope: [], chunks: [] },
    // Marginal/broken file: empty chunk set (parse yielded nothing usable).
    { relPath: "src/broken.ts", language: "typescript", imports: [], fileScope: [], chunks: [] },
  ];
}

async function newProvider(tmp: string): Promise<{ provider: CodegraphEnrichmentProvider; client: DuckDbGraphClient }> {
  const client = new DuckDbGraphClient({ path: join(tmp, `g-${Math.random().toString(36).slice(2)}.duckdb`) });
  await client.init();
  await runMigrations(client, MIG_DIR);
  const provider = new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
  return { provider, client };
}

describe("codegraph cross-pass drain determinism (yl9tv)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-determinism-"));
    rmSync(DIRECT_INPUT_SPILL, { force: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(DIRECT_INPUT_SPILL, { force: true });
  });

  it("drains the spill in a relPath-sorted order regardless of spill line order (R>=8)", async () => {
    const base = fixtureExtractions();
    const drainOrders: string[][] = [];
    const successRates: number[] = [];

    for (let run = 0; run < 8; run++) {
      rmSync(DIRECT_INPUT_SPILL, { force: true });
      // Deterministic per-run permutation of the spill line order — emulates
      // file-completion order varying with fileConcurrency.
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (i * 7 + run * 3 + 1) % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const { provider, client } = await newProvider(tmp);
      // Capture the order pass-2 processes files — resolveExtraction is called
      // once per drained file IN DRAIN ORDER, and its outcome feeds the
      // order-sensitive run-global merges + the resolve tally.
      const drainOrder: string[] = [];
      const target = provider as unknown as {
        resolveExtraction: (extraction: FileExtraction, ...rest: unknown[]) => unknown;
      };
      const original = target.resolveExtraction.bind(target);
      vi.spyOn(target, "resolveExtraction").mockImplementation((extraction: FileExtraction, ...rest: unknown[]) => {
        drainOrder.push(extraction.relPath);
        return original(extraction, ...rest);
      });

      // Unique per-run collection ⇒ a private input-spill path
      // (`xpass-<collectionName>.ndjson`), isolating this test from other
      // direct-mode cross-pass tests that share the cwd spill dir. In direct
      // mode (no pool) collectionName only routes the spill path; the single
      // injected graphDb is used regardless.
      const coll = `det_${run}_${Math.random().toString(36).slice(2)}`;
      // beginExtractionRun truncates the input spill, THEN acceptExtraction
      // appends each file in the (shuffled) completion order — mirrors the real
      // main-thread cross-pass feed.
      provider.beginExtractionRun(coll);
      for (const e of shuffled) provider.acceptExtraction(e, { collectionName: coll });
      await provider.streamFileBatch(
        tmp,
        base.map((e) => e.relPath),
        { crossPass: true, collectionName: coll },
      );
      await provider.finalizeSignals(tmp, {
        crossPass: true,
        paths: base.map((e) => e.relPath),
        collectionName: coll,
      });
      const constant = (await client.getRunStats()).find((r) => r.receiverKind === "constant");
      const attempted = constant?.attempted ?? 0;
      const resolved = constant?.resolved ?? 0;
      successRates.push(attempted === 0 ? 0 : resolved / attempted);

      drainOrders.push(drainOrder);
      await client.close();
    }

    // Every run drained in the SAME order, and that order is relPath-sorted.
    const sortedExpected = [...drainOrders[0]].sort();
    for (const order of drainOrders) {
      expect(order).toEqual(drainOrders[0]);
      expect(order).toEqual(sortedExpected);
    }
    // resolveSuccessRate is identical across all runs.
    for (const r of successRates) expect(r).toBe(successRates[0]);
  });
});
