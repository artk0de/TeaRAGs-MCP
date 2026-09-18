/**
 * The legacy `cg_run_stats` table is replaced per LANGUAGE, so the guard that
 * protects its last real measurement decides per language too (bd
 * tea-rags-mcp-sgo8v, on top of snbzk).
 *
 * The guard used to be run-wide: a whole-corpus run replaced every language's
 * rows as soon as ANY language tallied a call. A language whose files walked
 * without a single call site therefore had its previous measurement replaced by
 * zeros when it shared a run with a language that had calls — and kept it when
 * it ran alone. Under per-language affinity the same run is split by language,
 * so the table's content depended on how the collection was partitioned. Now
 * the decision is local to each language: it is replaced only when it measured
 * a call, whichever other languages share its run or its worker.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { ResolveRunStatsRow } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { FileExtractionAbsorbRole } from "../../../../../../src/core/contracts/types/provider.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

/** TypeScript files with call sites; one Ruby file with none. */
const CORPUS = ["src/foo.ts", "src/main.ts", "app/quiet.rb"];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cg-runstats-lang-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "src", "foo.ts"), "export class Foo {\n  static bar(): number { return 1; }\n}\n");
  writeFileSync(
    join(root, "src", "main.ts"),
    'import { Foo } from "./foo.js";\nexport function main(): void {\n  Foo.bar();\n  Mystery.nope();\n}\n',
  );
  writeFileSync(join(root, "app", "quiet.rb"), "class Quiet\n  def idle\n    1\n  end\nend\n");
  return root;
}

/** A Ruby measurement from an earlier run — what a call-free run must not erase. */
const EARLIER_RUBY: ResolveRunStatsRow = {
  language: "ruby",
  receiverKind: "constant",
  attempted: 7,
  resolved: 5,
  externalSkipped: 0,
  unresolvable: 0,
};

interface Graph {
  client: DuckDbGraphClient;
  dir: string;
}

async function openGraph(): Promise<Graph> {
  const dir = mkdtempSync(join(tmpdir(), "cg-runstats-lang-db-"));
  const client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  await client.recordRunStats([EARLIER_RUBY]);
  return { client, dir };
}

function providerOn(client: DuckDbGraphClient): CodegraphEnrichmentProvider {
  return new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
}

/** The legacy table itself — `getRunStats` reads covered languages elsewhere. */
async function legacyRows(client: DuckDbGraphClient): Promise<string[]> {
  const rows = await client.queryAll<Record<string, unknown>>(
    "SELECT language, receiver_kind, attempted, resolved FROM cg_run_stats ORDER BY language, receiver_kind",
  );
  return rows.map((row) => JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v)));
}

describe("CodegraphEnrichmentProvider — legacy run stats, per language", () => {
  let root: string;
  const graphs: Graph[] = [];

  beforeEach(() => {
    root = makeRepo();
  });

  afterEach(async () => {
    for (const graph of graphs.splice(0)) {
      await graph.client.close();
      rmSync(graph.dir, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("a language that tallied no call keeps its previous rows, even beside one that did", async () => {
    const graph = await openGraph();
    graphs.push(graph);
    const provider = providerOn(graph.client);

    await provider.streamFileBatch(root, CORPUS);
    await provider.finalizeSignals(root, { runCoverage: "wholeCorpus" });

    const rows = await legacyRows(graph.client);
    expect(rows.filter((r) => r.includes('"ruby"'))).toEqual([
      JSON.stringify({ language: "ruby", receiver_kind: "constant", attempted: 7, resolved: 5 }),
    ]);
    expect(rows.some((r) => r.includes('"typescript"') && r.includes('"attempted":2'))).toBe(true);
  });

  it("leaves the same table whether the run is one worker or one worker per language", async () => {
    const single = await openGraph();
    const split = await openGraph();
    graphs.push(single, split);

    const one = providerOn(single.client);
    const batch = await one.extractFileBatch(root, CORPUS);
    await one.absorbExtractedFiles(root, batch.extractions);
    await one.finalizeSignals(root, { runCoverage: "wholeCorpus" });

    for (const ownRuby of [false, true]) {
      const partition = providerOn(split.client);
      const absorbRoles: FileExtractionAbsorbRole[] = batch.extractions.map((e) =>
        e.relPath.endsWith(".rb") === ownRuby ? "own" : "mirror",
      );
      await partition.absorbExtractedFiles(root, batch.extractions, { absorbRoles });
      await partition.finalizeSignals(root, {
        runCoverage: "wholeCorpus",
        finalizeStage: "resolve",
        ownsCollectionCompletion: ownRuby,
      });
      await partition.finalizeSignals(root, { finalizeStage: "readBack", ownsCollectionCompletion: ownRuby });
    }

    expect(await legacyRows(split.client)).toEqual(await legacyRows(single.client));
  });
});
