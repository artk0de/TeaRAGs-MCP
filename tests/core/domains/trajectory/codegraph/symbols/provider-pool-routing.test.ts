/**
 * Pool routing regression — version-aware acquire (daemon redesign).
 *
 * The ingest pipeline writes Qdrant chunks to a versioned target
 * (`<alias>_v<N>`) during the first index pass because the alias doesn't
 * exist yet. `enrichment.prefetch` forwards that same `_v<N>` name to the
 * provider as `FileSignalOptions.collectionName`. Under the daemon redesign
 * the codegraph DuckDB file is keyed on the FULL versioned name: `getStore`
 * acquires it verbatim via `acquireWrite` (no version strip), and the RO
 * reader opens the same versioned file via `acquireRead`. Readers follow the
 * live version through the Qdrant alias swap, not an in-provider strip — so
 * write and read collapse onto the same `<alias>_v<N>.duckdb`.
 *
 * `stripVersionSuffix` is retained as an exported helper (other call sites /
 * tests reference it) but `getStore` no longer applies it. These tests pin:
 *
 *   1. `stripVersionSuffix` strips `_v<digits>$` only — arbitrary test
 *      collection names like "project-alpha" survive unchanged.
 *   2. `buildFileSignals` with a versioned `collectionName` lands rows in the
 *      versioned DuckDB file, so a follow-up `pool.acquire(<versioned>)`
 *      (the read path's key) sees the data.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import {
  CodegraphEnrichmentProvider,
  stripVersionSuffix,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { TSCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("stripVersionSuffix", () => {
  it("strips trailing _vN where N is digits", () => {
    expect(stripVersionSuffix("code_035da920_v6")).toBe("code_035da920");
    expect(stripVersionSuffix("code_abc_v1")).toBe("code_abc");
    expect(stripVersionSuffix("code_abc_v123")).toBe("code_abc");
  });

  it("leaves alias-shaped names unchanged", () => {
    expect(stripVersionSuffix("code_035da920")).toBe("code_035da920");
    expect(stripVersionSuffix("project-alpha")).toBe("project-alpha");
    expect(stripVersionSuffix("__direct__")).toBe("__direct__");
  });

  it("does not strip half-matches", () => {
    expect(stripVersionSuffix("foo_v")).toBe("foo_v"); // no digit
    expect(stripVersionSuffix("foo_vbar")).toBe("foo_vbar"); // not digits
    expect(stripVersionSuffix("foo_v1bar")).toBe("foo_v1bar"); // not at end
  });

  it("only strips a single trailing version segment", () => {
    expect(stripVersionSuffix("foo_v1_v2")).toBe("foo_v1");
  });
});

describe("CodegraphEnrichmentProvider — versioned-write / alias-read routing", () => {
  let tmp: string;
  let pool: GraphDbClientPool;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-pool-route-"));
    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    provider = new CodegraphEnrichmentProvider({
      pool,
      resolvers: new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]]),
    });
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes from a `_vN` collectionName land in the SAME versioned DuckDB the reader opens", async () => {
    // Synthetic project — one TS file under the temp root.
    const root = mkdtempSync(join(tmpdir(), "cg-pool-proj-"));
    writeFileSync(join(root, "foo.ts"), "export class Foo { bar() {} }\n");

    // Indexing threads the versioned name (`<alias>_v<N>`) into
    // FileSignalOptions.collectionName. Per the daemon redesign (no
    // version strip — getStore acquires the FULL name via acquireWrite),
    // the write lands in `code_demo_v3.duckdb`. The RO read path
    // (`acquireRead`) opens the SAME versioned file — both keyed on the
    // unstripped name. Readers follow the live version via the Qdrant
    // alias swap, NOT via an in-provider strip.
    await provider.buildFileSignals(root, { collectionName: "code_demo_v3" });

    // The reader opens the same versioned DuckDB file the write targeted.
    const versionedHandle = await pool.acquire("code_demo_v3");
    const symbols = await versionedHandle.graphDb.listAllSymbols();
    const fooSyms = symbols.filter((s) => s.shortName === "Foo" || s.shortName === "bar");
    expect(fooSyms.length).toBeGreaterThan(0);

    rmSync(root, { recursive: true, force: true });
  });

  it("arbitrary collection names (no `_vN` suffix) route to the literal name", async () => {
    // Tests historically use names like "project-alpha" to exercise
    // cross-collection isolation. `stripVersionSuffix` is a no-op on
    // these, so pool.acquire("project-alpha") opens
    // `<tmp>/codegraph/project-alpha.duckdb` exactly as before.
    const root = mkdtempSync(join(tmpdir(), "cg-pool-arbitrary-"));
    writeFileSync(join(root, "x.ts"), "export class XService { run() {} }\n");

    await provider.buildFileSignals(root, { collectionName: "project-alpha" });

    const handle = await pool.acquire("project-alpha");
    const symbols = await handle.graphDb.listAllSymbols();
    expect(symbols.length).toBeGreaterThan(0);

    rmSync(root, { recursive: true, force: true });
  });
});
