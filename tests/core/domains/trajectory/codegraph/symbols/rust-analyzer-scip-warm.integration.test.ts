/**
 * The rust-analyzer SCIP seam end to end (bd s3i8m.6 R2b): a direct-mode
 * provider whose `LanguageFactory` carries a fake `RustAnalyzerScipSource`
 * awaits it once, with the project root, before pass 2 — and the pass's
 * edges do not depend on how the acquisition settled, because nothing reads
 * the index yet (R3 does).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type {
  RustAnalyzerScipAcquisition,
  RustAnalyzerScipSource,
} from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

const FILES = {
  "src/lib.rs": "mod util;\n\npub fn run() {\n    util::helper();\n}\n",
  "src/util.rs": "pub fn helper() {}\n",
};

interface FakeSource {
  source: RustAnalyzerScipSource;
  calls: { projectRoot: string; admitted: "spawn" | "reuseOnly" }[];
}

/** Settles after a tick with `acquisition`; records the root and what admission said about the fixture. */
function fakeSource(acquisition: RustAnalyzerScipAcquisition): FakeSource {
  const calls: FakeSource["calls"] = [];
  return {
    calls,
    source: {
      acquire: async ({ projectRoot, admission }) => {
        calls.push({ projectRoot, admitted: admission(Object.keys(FILES)) });
        await new Promise((done) => setTimeout(done, 1));
        return acquisition;
      },
    },
  };
}

const ONE_POSITION_INDEX = {
  identity: "env:content",
  definitionAt: (relPath: string, line: number) =>
    relPath === "src/lib.rs" && line === 4
      ? {
          symbol: "rust-analyzer cargo mini 0.1.0 util/helper().",
          package: "mini",
          inProject: true,
          relPath: "src/util.rs",
          line: 1,
          name: "helper",
          kind: "callable" as const,
          packageInProject: true,
        }
      : null,
};

describe("rust-analyzer SCIP warm through a codegraph run (bd s3i8m.6 R2b)", () => {
  let tmp: string;
  let root: string;
  const clients: DuckDbGraphClient[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ra-scip-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ra-scip-root-"));
    for (const [relPath, content] of Object.entries(FILES)) {
      mkdirSync(join(root, relPath, ".."), { recursive: true });
      writeFileSync(join(root, relPath), content);
    }
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function indexWith(fake: FakeSource, dbName: string) {
    const client = new DuckDbGraphClient({ path: join(tmp, dbName) });
    clients.push(client);
    await client.init();
    await runMigrations(client, MIG_DIR);
    const languageFactory = new LanguageFactory({ rustAnalyzerScipSource: fake.source });
    const provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      languageFactory,
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    await provider.streamFileBatch(root, Object.keys(FILES));
    await provider.finalizeSignals(root, { runCoverage: "wholeCorpus" });
    return {
      callees: await client.getCalleeEdges(["run"]),
      diagnostics: languageFactory.create("rust").resolver?.diagnostics?.(),
    };
  }

  it("awaits the source once with the project root and reports the indexed outcome", async () => {
    const fake = fakeSource({ kind: "indexed", index: ONE_POSITION_INDEX, cacheHit: false, toolchainSkew: false });

    const { diagnostics } = await indexWith(fake, "indexed.duckdb");

    expect(fake.calls).toEqual([{ projectRoot: root, admitted: "spawn" }]);
    expect(diagnostics).toEqual({ rustAnalyzerScip: { outcome: "indexed", cacheHit: false, toolchainSkew: false } });
  });

  it("resolves the same edges whether the acquisition indexed or latched", async () => {
    const indexed = await indexWith(
      fakeSource({ kind: "indexed", index: ONE_POSITION_INDEX, cacheHit: true, toolchainSkew: false }),
      "indexed.duckdb",
    );
    const latched = await indexWith(
      fakeSource({ kind: "latched", reason: "offline", detail: "cargo metadata needs the network" }),
      "latched.duckdb",
    );

    expect(latched.diagnostics).toEqual({ rustAnalyzerScip: { outcome: "latched", reason: "offline" } });
    expect([...latched.callees]).toEqual([...indexed.callees]);
    expect([...indexed.callees.values()].flat()).toContain("helper");
  });
});
