/**
 * A `super` call whose base class lives OUTSIDE the project is an external call,
 * not a resolver miss (bd tea-rags-mcp-t5cji, follow-up).
 *
 * The family filter removed the fabricated edge every `class X extends Error`
 * used to get — `super('...')` landed on a Ruby `Error` model — and left the
 * call in the `resolveSuccessRate` denominator as a miss nothing can fix:
 * taxdome's super rate fell 0.84 → 0.34 on 16 such calls. The base is the
 * default lib's `Error`, or a dependency's class, and the checker says so.
 *
 * Through the real pipeline, type checker on, a dependency installed under the
 * corpus's own `node_modules`.
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
  "web/errors.ts": [
    "export class BlobProcessingFailedError extends Error {",
    "  constructor() {",
    '    super("Processing failed");',
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/bus.ts": [
    'import { BaseEmitter } from "emitter-pkg";',
    "export class Bus extends BaseEmitter {",
    "  fire(): void {",
    '    super.emit("ready");',
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/child.ts": [
    "export class Base {",
    "  save(): number {",
    "    return 1;",
    "  }",
    "}",
    "export class Child extends Base {",
    "  save(): number {",
    "    return super.save();",
    "  }",
    "}",
    "",
  ].join("\n"),
};

/** A dependency the way a real project installs one — under its own root. */
const PACKAGE: Readonly<Record<string, string>> = {
  "node_modules/emitter-pkg/package.json": JSON.stringify({
    name: "emitter-pkg",
    version: "1.0.0",
    types: "index.d.ts",
  }),
  "node_modules/emitter-pkg/index.d.ts": [
    "export declare class BaseEmitter {",
    "  emit(name: string): void;",
    "}",
    "",
  ].join("\n"),
};

interface RunStatsRow {
  attempted: number;
  resolved: number;
  external_skipped: number;
}

describe("a `super` call into a base outside the project is external (bd tea-rags-mcp-t5cji)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ts-super-external-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ts-super-external-repo-"));
    for (const [relPath, source] of Object.entries({ ...CORPUS, ...PACKAGE })) {
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

  it("counts `super` into the default lib and into a dependency as external, and still resolves a project base", async () => {
    const [row] = await client.queryAll<RunStatsRow>(
      "SELECT attempted, resolved, external_skipped FROM cg_run_stats WHERE language = 'typescript' AND receiver_kind = 'super'",
    );
    expect({
      attempted: Number(row.attempted),
      resolved: Number(row.resolved),
      externalSkipped: Number(row.external_skipped),
    }).toEqual({ attempted: 3, resolved: 1, externalSkipped: 2 });
  });
});
