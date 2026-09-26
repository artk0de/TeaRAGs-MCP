/**
 * The symbol → covering-chunk join covers EVERY walked symbol, including the
 * ones that share a start line (bd tea-rags-mcp-63l69).
 *
 * A Ruby association macro mints several symbols on its own line —
 * `has_many :statuses` yields `#statuses`, `#statuses=`, `#status_ids`,
 * `#status_ids=`; `delegate :email, :locale, to: :user` yields one per name.
 * The join used to project the walker's ranges to ONE symbol per start line
 * (the last walked), so only `#status_ids=` got a `chunk_id` and `find_symbol
 * Account#statuses` surfaced the symbol with no definition chunk, while a
 * single-symbol macro (`scope :recent`) joined cleanly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

describe("CodegraphEnrichmentProvider.buildChunkSignals — symbols sharing a start line (63l69)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-join-same-line-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function chunkIdOf(symbolId: string): Promise<string | null> {
    // Read the row directly: findSymbolChunk's last-segment tier would answer
    // with a same-tailed neighbour's chunk and hide an unjoined row.
    const rows = await client.queryAll<{ chunk_id: string | null }>(
      "SELECT chunk_id FROM cg_symbols WHERE symbol_id = ?",
      [symbolId],
    );
    return rows[0]?.chunk_id ?? null;
  }

  it("joins every symbol an association macro mints on one line, not just the last", async () => {
    const sink = provider.asExtractionSink();
    const line = (symbolId: string, at: number) => ({ symbolId, scope: [], calls: [], startLine: at, endLine: at });
    await sink.write({
      relPath: "app/models/account.rb",
      language: "typescript",
      imports: [],
      chunks: [
        { symbolId: "Account", scope: [], calls: [], startLine: 1, endLine: 10 },
        line("Account#statuses", 2),
        line("Account#statuses=", 2),
        line("Account#status_ids", 2),
        line("Account#status_ids=", 2),
        line("Account.recent", 4),
        line("Account#email", 5),
        line("Account#locale", 5),
        { symbolId: "Account#foo", scope: [], calls: [], startLine: 7, endLine: 9 },
      ],
      fileScope: [],
    });
    await sink.finish();

    await provider.buildChunkSignals(
      "/",
      new Map([
        [
          "app/models/account.rb",
          [
            { chunkId: "chunk-body", startLine: 1, endLine: 6 },
            { chunkId: "chunk-foo", startLine: 7, endLine: 9 },
          ],
        ],
      ]),
    );

    for (const symbolId of [
      "Account#statuses",
      "Account#statuses=",
      "Account#status_ids",
      "Account#status_ids=",
      "Account.recent",
      "Account#email",
      "Account#locale",
    ]) {
      expect({ symbolId, chunkId: await chunkIdOf(symbolId) }).toEqual({ symbolId, chunkId: "chunk-body" });
    }
    expect(await chunkIdOf("Account#foo")).toBe("chunk-foo");
  });
});
