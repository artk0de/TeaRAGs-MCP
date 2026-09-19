/**
 * A TypeScript MEMBER call is never resolved by short-name uniqueness alone
 * (bd tea-rags-mcp-t5cji, the guard half).
 *
 * `globalShortName` and `importNarrowedFallback` look a member up by its bare
 * name with the receiver discarded. For a receiver the walker typed that is
 * someone else's business, and for a bare call the name IS the callee. For
 * every other receiver the unique project symbol spelled like the member is a
 * coincidence unless the type checker agrees: taxdome's replay after the family
 * filter showed ~89 such sites, and every shape below reproduces on a
 * TypeScript-only corpus with no Ruby namesake to hide it:
 *
 *  - `COPY.title(...)` on an exported object literal landed on the only class
 *    method named `title`;
 *  - `data.items.filter(Boolean)` on an `any` receiver landed on the only
 *    `filter` the project declares, a static helper;
 *  - `new BlobFetcher().request()` — a class the codegraph does not walk
 *    (generated) — landed on a free function `request` in another file.
 *
 * Through the real pipeline: provider, `LanguageFactory` walkers and resolvers,
 * `CallEdgeResolutionRunner`, with the type checker on a corpus written to disk.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

const CORPUS: Readonly<Record<string, string>> = {
  "web/message.ts": [
    "export class Message {",
    "  title(): string {",
    '    return "m";',
    "  }",
    "}",
    "export class TaskHelper {",
    "  static filter(tasks: string[]): string[] {",
    "    return tasks;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/copy.ts": ["export const COPY = {", "  title: (name: string): string => name,", "};", ""].join("\n"),
  "web/api-client.ts": ["export function request(): number {", "  return 1;", "}", ""].join("\n"),
  // Generated, so the codegraph never walks it — the checker still reads it.
  "web/fetcher.generated.ts": [
    "export class BlobFetcher {",
    "  request(): number {",
    "    return 2;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/main.ts": [
    'import { COPY } from "./copy";',
    'import { BlobFetcher } from "./fetcher.generated";',
    'import { Message } from "./message";',
    "export function run(data: any): string {",
    "  const kept = data.items.filter(Boolean);",
    "  new BlobFetcher().request();",
    "  const label = new Message().title();",
    "  return COPY.title(String(kept.length)) + label;",
    "}",
    "export function bare(): number {",
    "  return request();",
    "}",
    "export function viaLocal(): number {",
    "  const fetcher = new BlobFetcher();",
    "  return fetcher.request();",
    "}",
    "",
  ].join("\n"),
};

interface MethodEdgeRow {
  source_symbol_id: string;
  call_expression: string;
  target_rel_path: string;
  target_symbol_id: string | null;
}

describe("TS member calls need the checker's agreement, not a unique short name (bd tea-rags-mcp-t5cji)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ts-member-evidence-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ts-member-evidence-repo-"));
    for (const [relPath, source] of Object.entries(CORPUS)) {
      mkdirSync(dirname(join(root, relPath)), { recursive: true });
      writeFileSync(join(root, relPath), source);
    }
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    const provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    const batch = await provider.extractFileBatch(root, Object.keys(CORPUS).sort());
    await provider.absorbExtractedFiles(root, batch.extractions);
    await provider.finalizeSignals(root);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const targetsOf = async (callExpression: string): Promise<string[]> =>
    (
      await client.queryAll<MethodEdgeRow>(
        "SELECT source_symbol_id, call_expression, target_rel_path, target_symbol_id FROM cg_symbols_edges_method",
      )
    )
      .filter((edge) => edge.call_expression === callExpression)
      .map((edge) => `${edge.target_rel_path}::${edge.target_symbol_id ?? ""}`)
      .sort();

  it("does not land an object-literal member call on the only class method of that name", async () => {
    expect(await targetsOf("COPY.title(String(kept.length))")).not.toContain("web/message.ts::Message#title");
  });

  it("does not land a member call on an `any` receiver on the only project symbol of that name", async () => {
    expect(await targetsOf("data.items.filter(Boolean)")).toEqual([]);
  });

  it("does not land a call on a class the table does not hold on a namesake free function", async () => {
    expect(await targetsOf("new BlobFetcher().request()")).not.toContain("web/api-client.ts::request");
  });

  it("does not treat a walker type the table does not know as evidence (fetcher.request() on a generated class)", async () => {
    expect(await targetsOf("fetcher.request()")).not.toContain("web/api-client.ts::request");
  });

  it("keeps a member call the checker types as the candidate's own class", async () => {
    expect(await targetsOf("new Message().title()")).toEqual(["web/message.ts::Message#title"]);
  });

  it("keeps the global fallback for a bare call", async () => {
    expect(await targetsOf("request()")).toEqual(["web/api-client.ts::request"]);
  });
});
