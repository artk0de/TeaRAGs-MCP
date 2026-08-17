/**
 * Pass-1 fan-out, provider half: `extractFileBatch` (parse + walk, runs on ANY
 * worker) and `absorbExtractedFiles` (everything stateful, runs only on the
 * collection-pinned one).
 *
 * The contract under test is an EQUIVALENCE: extracting elsewhere and absorbing
 * here must leave the same graph, the same symbol table and the same run tally
 * as the single-threaded `streamFileBatch` path it replaces. Everything else
 * here defends the two properties that make the split safe — extraction touches
 * no store, and absorb does not care what order records arrive in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

interface Harness {
  provider: CodegraphEnrichmentProvider;
  client: DuckDbGraphClient;
  dir: string;
}

async function buildProvider(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cg-fanout-db-"));
  const client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  const provider = new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
  return { provider, client, dir };
}

/** Small multi-file TS corpus with a resolvable cross-file call. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cg-fanout-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "spec"), { recursive: true });
  writeFileSync(join(root, "src", "foo.ts"), "export class Foo {\n  static bar(): number { return 1; }\n}\n");
  writeFileSync(join(root, "src", "baz.ts"), "export function baz(): number { return 2; }\n");
  writeFileSync(
    join(root, "src", "main.ts"),
    'import { Foo } from "./foo.js";\nimport { baz } from "./baz.js";\n' +
      "export function main(): number {\n  return Foo.bar() + baz();\n}\n",
  );
  writeFileSync(join(root, "src", "notes.md"), "# not a code file\n");
  writeFileSync(join(root, "spec", "foo.spec.ts"), 'describe("foo", () => { it("works", () => {}); });\n');
  return root;
}

const CORPUS = ["src/foo.ts", "src/baz.ts", "src/main.ts", "src/notes.md", "spec/foo.spec.ts"];

function extractionOf(relPath: string, language = "typescript"): FileExtraction {
  return { relPath, language, imports: [], chunks: [], fileScope: [] };
}

describe("CodegraphEnrichmentProvider — extractFileBatch", () => {
  let harness: Harness;
  let root: string;

  beforeEach(async () => {
    harness = await buildProvider();
    root = makeRepo();
  });

  afterEach(async () => {
    await harness.client.close();
    rmSync(harness.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("parses the supported, non-excluded files and reports pass-1 per language", async () => {
    const batch = await harness.provider.extractFileBatch(root, CORPUS);

    expect(batch.extractions.map((e) => e.relPath)).toEqual(["src/foo.ts", "src/baz.ts", "src/main.ts"]);
    expect(batch.pass1ByLanguage.typescript.files).toBe(3);
    expect(batch.pass1ByLanguage.typescript.ms).toBeGreaterThanOrEqual(0);
    // A test file is out of the graph unconditionally, a markdown file has no
    // walker — neither may reach the pinned worker's absorb.
    expect(batch.extractions.some((e) => e.relPath.startsWith("spec/"))).toBe(false);
  });

  it("writes nothing to the graph store — the pinned worker stays the only writer", async () => {
    const client = harness.client as unknown as Record<string, unknown>;
    const writeMethods = ["upsertSymbols", "upsertSymbolsBulk", "writeFileRowsGroup", "recordRunStats"] as const;
    const spies = writeMethods
      .filter((name) => typeof client[name] === "function")
      .map((name) => vi.spyOn(harness.client as never, name as never));
    expect(spies.length).toBeGreaterThan(0);

    await harness.provider.extractFileBatch(root, CORPUS);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(harness.provider.getRunMetrics()).toBeUndefined();
  });

  it("skips a file it cannot read instead of failing the shard", async () => {
    const batch = await harness.provider.extractFileBatch(root, ["src/foo.ts", "src/gone.ts"]);

    expect(batch.extractions.map((e) => e.relPath)).toEqual(["src/foo.ts"]);
  });
});

describe("CodegraphEnrichmentProvider — absorbExtractedFiles", () => {
  let fanout: Harness;
  let serial: Harness;
  let root: string;

  beforeEach(async () => {
    fanout = await buildProvider();
    serial = await buildProvider();
    root = makeRepo();
  });

  afterEach(async () => {
    await fanout.client.close();
    await serial.client.close();
    rmSync(fanout.dir, { recursive: true, force: true });
    rmSync(serial.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves the same graph as the single-threaded streamFileBatch path", async () => {
    await serial.provider.streamFileBatch(root, CORPUS);
    await serial.provider.finalizeSignals(root);

    const batch = await fanout.provider.extractFileBatch(root, CORPUS);
    await fanout.provider.absorbExtractedFiles(root, batch.extractions);
    await fanout.provider.finalizeSignals(root);

    const symbolsOf = async (h: Harness): Promise<string[]> =>
      (await h.client.listAllSymbols()).map((s) => `${s.relPath}::${s.symbolId}`).sort();
    expect(await symbolsOf(fanout)).toEqual(await symbolsOf(serial));
    expect(await symbolsOf(fanout)).not.toHaveLength(0);
  });

  it("counts the same extracted files and resolved calls as the serial path", async () => {
    await serial.provider.streamFileBatch(root, CORPUS);
    await serial.provider.finalizeSignals(root);
    const serialMetrics = serial.provider.getRunMetrics();

    const batch = await fanout.provider.extractFileBatch(root, CORPUS);
    await fanout.provider.absorbExtractedFiles(root, batch.extractions);
    await fanout.provider.finalizeSignals(root);
    const fanoutMetrics = fanout.provider.getRunMetrics();

    expect(fanoutMetrics?.extractedFiles).toBe(serialMetrics?.extractedFiles);
    expect(fanoutMetrics?.callsResolved).toBe(serialMetrics?.callsResolved);
    expect(fanoutMetrics?.extractedFiles).toBe(3);
  });

  it("is order-independent: a shuffled arrival order yields the same symbols", async () => {
    const batch = await fanout.provider.extractFileBatch(root, CORPUS);
    const shuffled = [...batch.extractions].reverse();

    await fanout.provider.absorbExtractedFiles(root, shuffled);
    await fanout.provider.finalizeSignals(root);

    const inOrder = await buildProvider();
    try {
      const same = await inOrder.provider.extractFileBatch(root, CORPUS);
      await inOrder.provider.absorbExtractedFiles(root, same.extractions);
      await inOrder.provider.finalizeSignals(root);

      const symbolsOf = async (h: Harness): Promise<string[]> =>
        (await h.client.listAllSymbols()).map((s) => `${s.relPath}::${s.symbolId}`).sort();
      expect(await symbolsOf(fanout)).toEqual(await symbolsOf(inOrder));
    } finally {
      await inOrder.client.close();
      rmSync(inOrder.dir, { recursive: true, force: true });
    }
  });

  it("absorbs a relPath once even when two batches carry it", async () => {
    const batch = await fanout.provider.extractFileBatch(root, ["src/foo.ts"]);

    await fanout.provider.absorbExtractedFiles(root, batch.extractions);
    await fanout.provider.absorbExtractedFiles(root, batch.extractions);
    await fanout.provider.finalizeSignals(root);

    expect(fanout.provider.getRunMetrics()?.extractedFiles).toBe(1);
  });

  it("folds the merged pass-1 attribution into the run's phase timings", async () => {
    const debug = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The progress line cadences on 500 files; with fan-out a single absorb
      // can cross that in one call, so the crossing — not an exact multiple —
      // is what must trigger it.
      const many = Array.from({ length: 501 }, (_, i) => extractionOf(`src/gen/f${i}.ts`));
      await fanout.provider.absorbExtractedFiles(root, many, {
        pass1ByLanguage: { typescript: { ms: 1234, files: 501 } },
      });

      const line = debug.mock.calls.find((call) => String(call[0]).includes("CODEGRAPH_PASS1_PROGRESS"));
      expect(line).toBeDefined();
      const payload = JSON.parse(String(line?.[1])) as {
        extracted: number;
        phases: { pass1: { files: number; ms: number; byLanguage?: Record<string, { files: number }> } };
      };
      expect(payload.extracted).toBe(501);
      expect(payload.phases.pass1.files).toBe(501);
      expect(payload.phases.pass1.ms).toBe(1234);
      expect(payload.phases.pass1.byLanguage?.typescript.files).toBe(501);
    } finally {
      debug.mockRestore();
    }
  });
});
