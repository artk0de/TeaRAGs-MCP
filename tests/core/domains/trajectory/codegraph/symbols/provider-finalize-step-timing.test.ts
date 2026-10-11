/**
 * Sub-step attribution of `CodegraphEnrichmentProvider#finalizeSignals`
 * (bd tea-rags-mcp-4ybh4).
 *
 * `fileFinalize` took 125-158 s in fast runs and 496-1214 s in slow ones with
 * nothing inside it carrying a timestamp. Each step of the worker-side finalize
 * now reports its own duration through the same DEBUG `console.error` channel
 * as `CODEGRAPH_PHASE_TIMINGS`, and costs nothing when DEBUG is off.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { writeMixedLanguageCorpus } from "../__helpers__/mixed-language-corpus.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { setDebug } from "../../../../../../src/core/primitives/diagnostics/debug-flag.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");
const STEP_LINE = "CODEGRAPH_FINALIZE_STEP";

describe("CodegraphEnrichmentProvider#finalizeSignals — step timing", () => {
  let dir: string;
  let root: string;
  let client: DuckDbGraphClient;
  let corpus: string[];
  let lines: { step: string; durationMs: number }[];
  let spy: ReturnType<typeof vi.spyOn>;

  const provider = (): CodegraphEnrichmentProvider =>
    new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-fin-timing-db-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    root = mkdtempSync(join(tmpdir(), "cg-fin-timing-repo-"));
    corpus = writeMixedLanguageCorpus(root);
    lines = [];
    spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes(STEP_LINE)) lines.push(JSON.parse(String(args[1])));
    });
  });

  afterEach(async () => {
    spy.mockRestore();
    setDebug(false);
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function runOneCall(crossPass: boolean): Promise<void> {
    const p = provider();
    const batch = await p.extractFileBatch(root, corpus);
    await p.absorbExtractedFiles(root, batch.extractions);
    await p.finalizeSignals(root, { crossPass });
  }

  it("reports spill drain, pass-2 resolve, overlay read and run-stats steps when DEBUG is on", async () => {
    setDebug(true);
    await runOneCall(true);

    expect(lines.map((l) => l.step)).toEqual(["spillDrain", "pass2Resolve", "readOverlays", "recordRunStats"]);
    for (const line of lines) {
      expect(typeof line.durationMs).toBe("number");
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("omits spill drain off cross-pass", async () => {
    setDebug(true);
    await runOneCall(false);
    expect(lines.map((l) => l.step)).toEqual(["pass2Resolve", "readOverlays", "recordRunStats"]);
  });

  it("times the read-back half of a partitioned finalize", async () => {
    setDebug(true);
    const p = provider();
    const batch = await p.extractFileBatch(root, corpus);
    await p.absorbExtractedFiles(root, batch.extractions);
    await p.finalizeSignals(root, { finalizeStage: "resolve", ownsCollectionCompletion: true });
    lines.length = 0;
    await p.finalizeSignals(root, { finalizeStage: "readBack", ownsCollectionCompletion: true });

    expect(lines.map((l) => l.step)).toEqual(["readBackRecompute", "readOverlays"]);
  });

  it("emits nothing when DEBUG is off", async () => {
    setDebug(false);
    await runOneCall(true);
    expect(lines).toEqual([]);
  });
});
