/**
 * G3a fix (bd tea-rags-mcp-lx8sb — ruby-graph-precision-wave2, DEFECT-1
 * residual): the cross-pass `acceptExtraction` tee MUST honor the provider's
 * `codegraphExclusionFilter`, exactly like the batch path
 * (`streamFileBatchInner`) and `buildFileSignals` already do.
 *
 * Live consequence of the gap: under `--force` the file-processor tees EVERY
 * chunked file into `acceptExtraction`, so `spec/support/gem_extensions/
 * capybara.rb` (a `module Capybara` reopening) enters the graph despite
 * CODEGRAPH_EXCLUDE_TESTS=true — making `Capybara` look in-project, defeating
 * the DEFECT-1 external-root gate, and re-recording the dnd_helpers
 * `cg_ambiguous_fanout` rows on every force reindex (see
 * provider-ambiguous-fanout-spec-reopen.test.ts for the gate-defeat half).
 *
 * INVARIANT pinned here (observable data contract, not call sequence): the
 * cross-pass input spill file — the main→worker NDJSON bridge that the
 * worker's `finalizeSignals` later drains — receives extractions ONLY for
 * files the exclusion filter admits. A test-classified relPath is dropped;
 * an app relPath of the same shape is spilled.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

/** Unique per-run collection name so the direct-mode spill file is ours alone. */
const COLLECTION = `cgtest_accept_excl_${process.pid}_${Math.floor(performance.now())}`;
const SPILL_PATH = join(process.cwd(), ".tea-rags-codegraph-spill", `xpass-${COLLECTION}.ndjson`);

const extractionFor = (relPath: string): FileExtraction => ({
  relPath,
  language: "ruby",
  imports: [],
  chunks: [],
  fileScope: [],
});

describe("CodegraphEnrichmentProvider.acceptExtraction — exclusion filter on the cross-pass tee (G3a)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-accept-excl-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
      exclusion: { excludeTests: true, customPatterns: [] },
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(SPILL_PATH, { force: true });
  });

  it("spills an app extraction but DROPS a test-classified one (spec/support, spec/mailers/previews)", () => {
    provider.acceptExtraction(extractionFor("app/models/invoice.rb"), { collectionName: COLLECTION });
    provider.acceptExtraction(extractionFor("spec/support/gem_extensions/capybara.rb"), {
      collectionName: COLLECTION,
    });
    provider.acceptExtraction(extractionFor("spec/mailers/previews/document_mailer_preview.rb"), {
      collectionName: COLLECTION,
    });

    const spilled = readFileSync(SPILL_PATH, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as FileExtraction).relPath);
    expect(spilled).toEqual(["app/models/invoice.rb"]);
  });

  it("with excludeTests:false the same spec paths ARE spilled (filter, not a hardcoded spec/ ban)", () => {
    const permissive = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
      exclusion: { excludeTests: false, customPatterns: [] },
    });
    const permissiveCollection = `${COLLECTION}_perm`;
    const permissiveSpill = join(process.cwd(), ".tea-rags-codegraph-spill", `xpass-${permissiveCollection}.ndjson`);
    try {
      permissive.acceptExtraction(extractionFor("spec/support/dnd_helpers.rb"), {
        collectionName: permissiveCollection,
      });
      expect(existsSync(permissiveSpill)).toBe(true);
      const spilled = readFileSync(permissiveSpill, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => (JSON.parse(l) as FileExtraction).relPath);
      expect(spilled).toEqual(["spec/support/dnd_helpers.rb"]);
    } finally {
      rmSync(permissiveSpill, { force: true });
    }
  });
});
