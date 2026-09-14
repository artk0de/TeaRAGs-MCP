import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { summarizeCodegraphResolve } from "../../../../../../src/core/domains/ingest/pipeline/status-module.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

// bd tea-rags-mcp-xpmwg — the persisted resolve breakdown must describe the
// CORPUS, not the last run's batch. Live on taxdome: typescript bareCall
// 122777/175773 after a full recompute shrank to a batch-sized count after a
// one-file incremental, `summarizeCodegraphResolve` then dropped typescript
// under MIN_LANGUAGE_SHARE, and prime showed ruby alone.
describe("CodegraphEnrichmentProvider — per-file resolve stats (xpmwg)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const write = (relPath: string, content: string): void => {
    mkdirSync(join(root, relPath, ".."), { recursive: true });
    writeFileSync(join(root, relPath), content);
  };

  const constantTs = async (): Promise<{ attempted: number; resolved: number } | undefined> => {
    const row = (await client.getRunStats()).find((r) => r.language === "typescript" && r.receiverKind === "constant");
    return row ? { attempted: row.attempted, resolved: row.resolved } : undefined;
  };

  /** foo.ts defines the target; main.ts: 2 constant calls, 1 resolved; other.ts: 3 constant calls, all resolved. */
  const writeTsCorpus = (): string[] => {
    write("src/foo.ts", "export class Foo {\n  static bar(): number { return 1; }\n}\n");
    write(
      "src/main.ts",
      'import { Foo } from "./foo.js";\nexport function main(): void {\n  Foo.bar();\n  Mystery.nope();\n}\n',
    );
    write(
      "src/other.ts",
      'import { Foo } from "./foo.js";\nexport function other(): void {\n  Foo.bar();\n  Foo.bar();\n  Foo.bar();\n}\n',
    );
    return ["src/foo.ts", "src/main.ts", "src/other.ts"];
  };

  const wholeCorpusRun = async (paths: string[]): Promise<void> => {
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root, { runCoverage: "wholeCorpus" });
  };

  const incrementalRun = async (paths: string[]): Promise<void> => {
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root, { runCoverage: "subset" });
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-file-resolve-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-file-resolve-root-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("an incremental run over one file leaves every other file's tally in the aggregate", async () => {
    await wholeCorpusRun(writeTsCorpus());
    expect(await constantTs()).toEqual({ attempted: 5, resolved: 4 });

    await incrementalRun(["src/main.ts"]);

    expect(await constantTs()).toEqual({ attempted: 5, resolved: 4 });
  });

  it("re-resolving a changed file replaces its tally rather than adding to it", async () => {
    await wholeCorpusRun(writeTsCorpus());

    // main.ts loses its unresolvable call: 2/1 becomes 1/1.
    write("src/main.ts", 'import { Foo } from "./foo.js";\nexport function main(): void {\n  Foo.bar();\n}\n');
    await incrementalRun(["src/main.ts"]);

    expect(await constantTs()).toEqual({ attempted: 4, resolved: 4 });
  });

  it("a deleted file's tally leaves the aggregate", async () => {
    await wholeCorpusRun(writeTsCorpus());

    rmSync(join(root, "src/other.ts"));
    await provider.handleDeletedPaths(["src/other.ts"]);

    expect(await constantTs()).toEqual({ attempted: 2, resolved: 1 });
  });

  it("before any whole-corpus run, an incremental run leaves the legacy measurement as the answer", async () => {
    writeTsCorpus();
    // The index as the previous build left it: a full measurement in
    // cg_run_stats, nothing per file.
    await client.recordRunStats([
      {
        language: "typescript",
        receiverKind: "constant",
        attempted: 1000,
        resolved: 900,
        externalSkipped: 0,
        unresolvable: 0,
      },
    ]);

    await incrementalRun(["src/foo.ts", "src/main.ts"]);

    expect(await constantTs()).toEqual({ attempted: 1000, resolved: 900 });
  });

  it("keeps both languages in the resolve summary after a small incremental on a two-language corpus", async () => {
    const tsPaths = ["src/foo.ts", "src/big.ts", "src/small.ts"];
    write("src/foo.ts", "export class Foo {\n  static bar(): number { return 1; }\n}\n");
    write(
      "src/big.ts",
      `import { Foo } from "./foo.js";\nexport function big(): void {\n${"  Foo.bar();\n".repeat(21)}}\n`,
    );
    write("src/small.ts", 'import { Foo } from "./foo.js";\nexport function small(): void {\n  Foo.bar();\n}\n');
    const rbPaths = ["app/helper.rb", "app/worker.rb"];
    write("app/helper.rb", "class Helper\n  def self.go\n    :ok\n  end\nend\n");
    write("app/worker.rb", `class Worker\n  def run\n${"    Helper.go\n".repeat(25)}  end\nend\n`);

    await wholeCorpusRun([...tsPaths, ...rbPaths]);
    const before = summarizeCodegraphResolve(await client.getRunStats());
    expect(before?.byLanguage?.map((l) => l.language).sort()).toEqual(["ruby", "typescript"]);

    // One typescript file with one call: batch-sized, far under the 5% share
    // floor against ruby's 25 calls.
    await incrementalRun(["src/small.ts"]);

    const after = summarizeCodegraphResolve(await client.getRunStats());
    expect(after?.byLanguage?.map((l) => l.language).sort()).toEqual(["ruby", "typescript"]);
    expect(after?.callsAttempted).toBe(before?.callsAttempted);
  });
});
