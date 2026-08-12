/**
 * The TypeScript resolver must read the tsconfig of the project the RUN is
 * indexing (bd tea-rags-mcp-f4wcm follow-up).
 *
 * `tea-rags-mcp-f4wcm` gave `LanguageFactory` a constructor-time `repoRoot` and
 * the codegraph provider factory filled it with `config.rootDir` — which is the
 * DuckDB storage root (`paths.appData`), built once at bootstrap before any
 * project is known, and never a project directory. The inline composition root
 * passed no root at all, leaving `process.cwd()`. Either way `loadTsConfig`
 * looked for `tsconfig.json` somewhere that is not the indexed repo, found
 * none, and silently resolved "without path aliases" — so every aliased import
 * in a project like taxdome produced no file edge at all.
 *
 * The invariant pinned here is the observable one, stated without reference to
 * how the root is threaded: given a project whose `tsconfig.json` maps
 * `@app/*` → `src/*`, an aliased import inside that project yields a file edge
 * to the file the alias names. The provider is built exactly as production
 * builds it — a real `LanguageFactory` that was told nothing about the fixture,
 * and a DuckDB root that is a DIFFERENT directory from the project root, which
 * is the shape that made the defect invisible to every earlier unit test.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
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

/**
 * `@app/*` is deliberately a pattern this repo's own `tsconfig.json` does not
 * declare — it has no `paths` at all. So an alias that resolves can only have
 * come from the FIXTURE's tsconfig, never from the tsconfig of whatever
 * directory the test process happens to run in.
 */
const TSCONFIG = JSON.stringify(
  { compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } }, include: ["src/**/*"] },
  null,
  2,
);

describe("CodegraphEnrichmentProvider — TypeScript resolves against the INDEXED project's tsconfig", () => {
  let dbDir: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    mkdirSync(join(root, "src", "app"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
    writeFileSync(
      join(root, "src", "lib", "greeter.ts"),
      ["export class Greeter {", "  static greet(): void {}", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "app", "page.ts"),
      [
        'import { Greeter } from "@app/lib/greeter";',
        "",
        "export function render(): void {",
        "  Greeter.greet();",
        "}",
        "",
      ].join("\n"),
    );
    return ["src/lib/greeter.ts", "src/app/page.ts"];
  };

  beforeEach(async () => {
    // The DuckDB root and the project root are DIFFERENT directories, exactly
    // as in production (`paths.appData` vs the indexed repo). Conflating them
    // is what the defect did.
    dbDir = mkdtempSync(join(tmpdir(), "cg-ts-tsconfig-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ts-tsconfig-project-"));
    client = new DuckDbGraphClient({ path: join(dbDir, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      // A real factory, told NOTHING about the fixture — the production shape.
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("maps a tsconfig path alias to a file edge for the project being indexed", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const fileEdges = await client.queryAll<{ source_rel_path: string; target_rel_path: string }>(
      "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file",
    );

    // `resolveFileEdges` maps import specifiers through `mapImportToFile` and
    // nothing else — no short-name fallback can manufacture this edge. It
    // exists iff the alias was read from the fixture's tsconfig.
    expect(fileEdges).toContainEqual({ source_rel_path: "src/app/page.ts", target_rel_path: "src/lib/greeter.ts" });
  });

  it("resolves the aliased call to the symbol the alias names", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const methodEdges = await client.queryAll<{ target_rel_path: string; target_symbol_id: string }>(
      "SELECT target_rel_path, target_symbol_id FROM cg_symbols_edges_method WHERE source_rel_path = 'src/app/page.ts'",
    );

    expect(methodEdges).toContainEqual({ target_rel_path: "src/lib/greeter.ts", target_symbol_id: "Greeter.greet" });
  });
});
