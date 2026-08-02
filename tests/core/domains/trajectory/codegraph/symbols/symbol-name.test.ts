import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { lastSegment } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

describe("lastSegment", () => {
  it("splits an instance-method symbolId on '#'", () => {
    expect(lastSegment("Foo#bar")).toBe("bar");
  });

  it("splits a static / nested-namespace symbolId on '.'", () => {
    expect(lastSegment("Foo.bar")).toBe("bar");
  });

  it("splits an import path on '/' and keeps the extension", () => {
    expect(lastSegment("../core/api/index.js")).toBe("index.js");
  });

  it("strips the '~N' overload-arity suffix (bd a466)", () => {
    expect(lastSegment("Foo.bar~2")).toBe("bar");
  });

  it("returns an unqualified name unchanged", () => {
    expect(lastSegment("bar")).toBe("bar");
  });

  // bd tea-rags-mcp-jii03 — a compact-FQ declaration (`class GettingPaid::Bill`)
  // carries its namespace in the symbolId, so the short name MUST be the segment
  // after the last `::`. Without this, `lookupByShortName("Bill")` answers zero
  // and every convention / short-name channel goes blind on namespaced models.
  it("splits a `::`-scoped constant on the last '::'", () => {
    expect(lastSegment("GettingPaid::Bill")).toBe("Bill");
  });

  it("splits a deeply `::`-scoped constant on the LAST '::'", () => {
    expect(lastSegment("Billing::GettingPaid::Bill")).toBe("Bill");
  });

  it("prefers the later separator when '#' follows '::'", () => {
    expect(lastSegment("GettingPaid::Bill#save")).toBe("save");
  });

  it("prefers the later separator when '.' follows '::'", () => {
    expect(lastSegment("GettingPaid::Bill.create")).toBe("create");
  });

  it("prefers '::' when it follows a '.' (Rust-style nested path)", () => {
    expect(lastSegment("crate::mod::Type")).toBe("Type");
  });

  it("strips the arity suffix from a `::`-scoped instance method", () => {
    expect(lastSegment("GettingPaid::Bill#save~2")).toBe("save");
  });

  it("still treats '/' as the path separator when '::' is present", () => {
    expect(lastSegment("app/models/getting_paid/bill.rb")).toBe("bill.rb");
  });
});

describe("SymbolDefinition.shortName for compact-FQ declarations (bd tea-rags-mcp-jii03)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let table: InMemoryGlobalSymbolTable;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-symbol-name-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    table = new InMemoryGlobalSymbolTable();
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: table,
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes `class GettingPaid::Bill` under the short name `Bill`", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "app/models/getting_paid/bill.rb",
      language: "ruby",
      imports: [],
      chunks: [
        { symbolId: "GettingPaid::Bill", scope: [], calls: [] },
        { symbolId: "GettingPaid::Bill#save", scope: ["GettingPaid::Bill"], calls: [] },
      ],
      fileScope: ["GettingPaid::Bill"],
    });
    await sink.finish();

    expect(table.lookupByShortName("Bill").map((d) => d.symbolId)).toEqual(["GettingPaid::Bill"]);
    expect(table.lookupByShortName("save").map((d) => d.symbolId)).toEqual(["GettingPaid::Bill#save"]);
  });
});
