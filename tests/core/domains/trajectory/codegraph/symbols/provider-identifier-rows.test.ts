/**
 * Write wiring of `cg_identifiers` (bd tea-rags-mcp-4p3sb.9): BOTH node-write
 * entry points — the incremental sink `write` and the cross-pass
 * `acceptExtraction` eager buffer — carry a file's identifier rows through the
 * node flush, so either run shape leaves the table filled.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cg-ident-"));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function makeClient(): Promise<DuckDbGraphClient> {
  const tmp = mkdtempSync(join(tmpdir(), "cg-ident-db-"));
  const client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  cleanups.push(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  return client;
}

function makeProvider(client: DuckDbGraphClient): CodegraphEnrichmentProvider {
  return new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
}

interface StoredIdentifier {
  rel_path: string;
  owner_symbol_id: string;
  kind: string;
  name: string;
  type_name: string | null;
  type_source: string | null;
  bound_member: string | null;
  bound_receiver: string | null;
  bound_call_expression: string | null;
}

async function storedIdentifiers(client: DuckDbGraphClient): Promise<StoredIdentifier[]> {
  return client.queryAll<StoredIdentifier>(
    `SELECT rel_path, owner_symbol_id, kind, name, type_name, type_source, bound_member, bound_receiver,
            bound_call_expression FROM cg_identifiers ORDER BY rel_path, line, name`,
  );
}

describe("CodegraphEnrichmentProvider — cg_identifiers write wiring", () => {
  it("the incremental sink path persists a Ruby file's declarations, typing a finder-bound local", async () => {
    const client = await makeClient();
    const provider = makeProvider(client);
    const root = makeRepo({
      "app/services/process_event.rb": [
        "class ProcessEvent",
        "  def call(id)",
        "    document = TaxDocument.find_by!(id: id)",
        "    document.save",
        "  end",
        "end",
        "",
      ].join("\n"),
    });

    await provider.streamFileBatch(root, ["app/services/process_event.rb"]);
    await provider.finalizeSignals(root);

    const rows = await storedIdentifiers(client);
    expect(rows.find((r) => r.kind === "param" && r.name === "id")).toMatchObject({
      rel_path: "app/services/process_event.rb",
      owner_symbol_id: "ProcessEvent#call",
    });
    const document = rows.find((r) => r.name === "document");
    expect(document).toMatchObject({
      kind: "local",
      type_name: "TaxDocument",
      bound_member: "find_by!",
      bound_receiver: "TaxDocument",
    });
    expect(["binding", "finder"]).toContain(document?.type_source);
    expect(document?.bound_call_expression).toContain("TaxDocument.find_by!");
  });

  it("the cross-pass acceptExtraction path persists the declarations it buffered", async () => {
    const client = await makeClient();
    const provider = makeProvider(client);
    const collectionName = `ident_${randomUUID().replace(/-/g, "")}`;
    const tmp = mkdtempSync(join(tmpdir(), "cg-ident-xpass-"));
    cleanups.push(() => {
      rmSync(tmp, { recursive: true, force: true });
    });
    const extraction: FileExtraction = {
      relPath: "src/svc.ts",
      language: "typescript",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "Svc#run", scope: ["Svc"], calls: [], startLine: 1, endLine: 3 }],
      identifierDeclarations: [
        { name: "doc", kind: "param", line: 1, ownerSymbolId: "Svc#run", typeName: "Doc", typeSource: "annotation" },
      ],
    };

    provider.beginExtractionRun(collectionName);
    provider.acceptExtraction(extraction, { collectionName });
    await provider.streamFileBatch(tmp, [extraction.relPath], { crossPass: true, collectionName });
    await provider.finalizeSignals(tmp, { crossPass: true, paths: [extraction.relPath], collectionName });

    expect(await storedIdentifiers(client)).toEqual([
      {
        rel_path: "src/svc.ts",
        owner_symbol_id: "Svc#run",
        kind: "param",
        name: "doc",
        type_name: "Doc",
        type_source: "annotation",
        bound_member: null,
        bound_receiver: null,
        bound_call_expression: null,
      },
    ]);
  });
});
