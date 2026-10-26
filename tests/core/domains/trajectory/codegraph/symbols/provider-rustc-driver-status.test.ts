/**
 * The rustc call-site driver's outcome is reported by the Rust resolver inside
 * the enrichment worker (bd s3i8m). The worker's finalize already writes the
 * run's resolve tally into the collection's codegraph DB; the driver status
 * rides that same write, so status and prime — other processes, later — read
 * what this run's Rust pass actually did.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { languageFactory } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type {
  LanguageFactoryDescriptor,
  LanguageProvider,
} from "../../../../../../src/core/contracts/types/language.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/** The real factory, with the Rust resolver's report replaced by `report`. */
function factoryReportingRust(report: Record<string, unknown> | undefined): LanguageFactoryDescriptor {
  const real = languageFactory();
  const wrapped = new Map<string, LanguageProvider>();
  return {
    ...real,
    supported: () => real.supported(),
    signalFloors: () => real.signalFloors(),
    create: (lang: string) => {
      if (lang !== "rust") return real.create(lang);
      let provider = wrapped.get(lang);
      if (!provider) {
        const base = real.create(lang);
        const resolver = base.resolver === undefined ? undefined : Object.create(base.resolver);
        if (resolver) resolver.diagnostics = () => report;
        provider = Object.create(base, { resolver: { value: resolver } }) as LanguageProvider;
        wrapped.set(lang, provider);
      }
      return provider;
    },
  };
}

describe("CodegraphEnrichmentProvider — rustc driver status", () => {
  let root: string;
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cg-rustc-driver-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "lib.rs"), "pub fn helper() -> u32 { 1 }\npub fn main() { helper(); }\n");
    writeFileSync(join(root, "src", "foo.ts"), "export function foo(): number { return 1; }\n");
    dir = mkdtempSync(join(tmpdir(), "cg-rustc-driver-db-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function providerReporting(report: Record<string, unknown> | undefined): CodegraphEnrichmentProvider {
    return new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      languageFactory: factoryReportingRust(report),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  }

  it("persists the Rust pass's driver outcome with the time the run finalized", async () => {
    const provider = providerReporting({
      rustcCallSites: { outcome: "indexed", cacheHit: true, units: 3, wallMs: 1200 },
    });
    const before = Date.now();

    await provider.streamFileBatch(root, ["src/lib.rs", "src/foo.ts"]);
    await provider.finalizeSignals(root, { runCoverage: "subset" });

    const record = await client.getRustcDriverStatus();
    expect(record?.status).toEqual({ outcome: "indexed", cacheHit: true, units: 3, wallMs: 1200 });
    expect(record?.recordedAtMs).toBeGreaterThanOrEqual(before);
  });

  it("leaves the previous record when the run resolved no Rust", async () => {
    await client.recordRustcDriverStatus({ status: { outcome: "off" }, recordedAtMs: 7 });
    const provider = providerReporting({ rustcCallSites: { outcome: "skipped", reason: "unavailable" } });

    await provider.streamFileBatch(root, ["src/foo.ts"]);
    await provider.finalizeSignals(root, { runCoverage: "subset" });

    expect(await client.getRustcDriverStatus()).toEqual({ status: { outcome: "off" }, recordedAtMs: 7 });
  });

  it("writes nothing when the Rust resolver reported no call-site acquisition", async () => {
    const provider = providerReporting(undefined);

    await provider.streamFileBatch(root, ["src/lib.rs"]);
    await provider.finalizeSignals(root, { runCoverage: "subset" });

    expect(await client.getRustcDriverStatus()).toBeNull();
  });
});
