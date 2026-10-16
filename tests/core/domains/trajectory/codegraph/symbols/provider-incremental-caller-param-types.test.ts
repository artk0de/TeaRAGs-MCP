/**
 * Full == incremental for parameter types read from callers (bd
 * tea-rags-mcp-2m83f.49, follow-up of 2m83f.44).
 *
 *   class Worker
 *     def perform(record)   # typed only by its callers
 *       record.firm.name
 *     end
 *   end
 *
 * The callers live in other files. An incremental run that walks only some of
 * them must fold the persisted observations of the rest, and re-resolve the
 * unchanged `Worker` when what its callers agree on moves — or the incremental
 * graph differs from a fresh full index over the same tree.
 *
 * Driven through the real write path (provider over DuckDB with every
 * migration, content hashes stamped like the ingest pipeline, drift repair
 * first), like `provider-incremental-cone-invalidation.test.ts`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const COLLECTION = "code_caller_param_inval_v1" as never;

// ─── Fixture ────────────────────────────────────────────────────────────────

const MODELS: Record<string, string> = {
  "app/firm.rb": "class Firm\n  def name\n    :firm\n  end\nend\n",
  "app/office.rb": "class Office\n  def name\n    :office\n  end\nend\n",
  "app/invoice.rb": "class Invoice\n  def firm\n    Firm.new\n  end\nend\n",
  "app/client.rb": "class Client\n  def firm\n    Office.new\n  end\nend\n",
};

const WORKER = "app/worker.rb";
const WORKER_SRC = "class Worker\n  def perform(record)\n    record.firm.name\n  end\nend\n";
const WORKER_TOUCHED = "class Worker\n  # touched\n  def perform(record)\n    record.firm.name\n  end\nend\n";

const ALPHA = "app/alpha_job.rb";
const BETA = "app/beta_job.rb";
const job = (name: string, arg: string): string =>
  `class ${name}\n  def run\n    Worker.new.perform(${arg})\n  end\nend\n`;

// ─── Harness ────────────────────────────────────────────────────────────────

interface Project {
  client: DuckDbGraphClient;
  write: (relPath: string, source: string) => void;
  remove: (relPath: string) => void;
  reindex: (changed: string[]) => Promise<void>;
}

const sha = (source: string): string => createHash("sha256").update(source).digest("hex");

async function makeProject(files: Record<string, string>): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), "cg-caller-param-inval-src-"));
  const dbDir = mkdtempSync(join(tmpdir(), "cg-caller-param-inval-db-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });
  const present = new Set<string>();
  const write = (relPath: string, source: string): void => {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), source);
    present.add(relPath);
  };
  for (const [rel, src] of Object.entries(files)) write(rel, src);
  const client = new DuckDbGraphClient({ path: join(dbDir, "g.duckdb") });
  await client.init();
  await runMigrations(client, DATABASE_MIGRATIONS);
  cleanups.push(async () => client.close());
  const provider = new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
  const scannedHashes = (): Map<string, string> =>
    new Map([...present].map((rel) => [rel, sha(readFileSync(join(root, rel), "utf8"))]));
  return {
    client,
    write,
    remove: (relPath) => {
      unlinkSync(join(root, relPath));
      present.delete(relPath);
    },
    reindex: async (changed) => {
      const contentHashes = scannedHashes();
      const coordinator = new EnrichmentCoordinator({} as never, provider, undefined, new InlineEnrichmentExecutor());
      await coordinator.runRepairPass(COLLECTION, root, contentHashes);
      if (changed.length > 0) {
        await provider.streamFileBatch(root, changed, { collectionName: COLLECTION, contentHashes });
      }
      await provider.finalizeSignals(root, { collectionName: COLLECTION, contentHashes });
    },
  };
}

async function fullIndex(files: Record<string, string>): Promise<Project> {
  const project = await makeProject(files);
  await project.reindex(Object.keys(files));
  return project;
}

/** `Worker#perform`'s persisted callees as `call -> target`, sorted. */
async function performCallees(client: DuckDbGraphClient): Promise<string[]> {
  const rows = await client.queryAll<{ call: string; target: string | null }>(
    `SELECT call_expression AS call, target_symbol_id AS target FROM cg_symbols_edges_method
      WHERE source_symbol_id = 'Worker#perform'`,
  );
  return rows.map((r) => `${r.call} -> ${r.target ?? "<file>"}`).sort();
}

async function observationSources(client: DuckDbGraphClient): Promise<string[]> {
  const rows = await client.queryAll<{ source_rel_path: string }>(
    "SELECT DISTINCT source_rel_path FROM cg_caller_param_observations ORDER BY source_rel_path",
  );
  return rows.map((r) => r.source_rel_path);
}

const TYPED_READING = ["record.firm -> Invoice#firm", "record.firm.name -> Firm#name"];

describe("incremental caller-parameter typing == full (bd tea-rags-mcp-2m83f.49)", () => {
  it("re-walking only the callee keeps the type its unwalked callers agree on", async () => {
    const files = {
      ...MODELS,
      [WORKER]: WORKER_SRC,
      [ALPHA]: job("AlphaJob", "Invoice.new"),
      [BETA]: job("BetaJob", "Invoice.new"),
    };
    const project = await fullIndex(files);
    expect(await performCallees(project.client)).toEqual(TYPED_READING);

    project.write(WORKER, WORKER_TOUCHED);
    await project.reindex([WORKER]);

    const reference = await fullIndex({ ...files, [WORKER]: WORKER_TOUCHED });
    expect(await performCallees(reference.client)).toEqual(TYPED_READING);
    expect(await performCallees(project.client)).toEqual(await performCallees(reference.client));
  });

  it("a caller that changes its argument type re-resolves the unchanged callee", async () => {
    const files = {
      ...MODELS,
      [WORKER]: WORKER_SRC,
      [ALPHA]: job("AlphaJob", "Invoice.new"),
      [BETA]: job("BetaJob", "Invoice.new"),
    };
    const project = await fullIndex(files);
    expect(await performCallees(project.client)).toEqual(TYPED_READING);

    const beta = job("BetaJob", "Client.new");
    project.write(BETA, beta);
    await project.reindex([BETA]);

    const reference = await fullIndex({ ...files, [BETA]: beta });
    expect(await performCallees(reference.client)).not.toEqual(TYPED_READING);
    expect(await performCallees(project.client)).toEqual(await performCallees(reference.client));
  });

  it("a caller that starts passing a typed argument types the unchanged callee", async () => {
    const files = {
      ...MODELS,
      [WORKER]: WORKER_SRC,
      [ALPHA]: job("AlphaJob", "Invoice.new"),
      [BETA]: job("BetaJob", "Client.new"),
    };
    const project = await fullIndex(files);
    expect(await performCallees(project.client)).not.toEqual(TYPED_READING);

    const beta = job("BetaJob", "Invoice.new");
    project.write(BETA, beta);
    await project.reindex([BETA]);

    expect(await performCallees(project.client)).toEqual(TYPED_READING);
  });

  it("deleting a caller removes its observations and re-resolves the callee (deletion-only run)", async () => {
    const files = {
      ...MODELS,
      [WORKER]: WORKER_SRC,
      [ALPHA]: job("AlphaJob", "Invoice.new"),
      [BETA]: job("BetaJob", "Client.new"),
    };
    const project = await fullIndex(files);
    expect(await observationSources(project.client)).toEqual([ALPHA, BETA]);

    project.remove(BETA);
    await project.reindex([]);

    expect(await observationSources(project.client)).toEqual([ALPHA]);
    const { [BETA]: _gone, ...rest } = files;
    const reference = await fullIndex(rest);
    expect(await performCallees(reference.client)).toEqual(TYPED_READING);
    expect(await performCallees(project.client)).toEqual(await performCallees(reference.client));
  });
});
