/**
 * A `this` member the checker declares OUTSIDE the project is an external call,
 * not a resolver miss (bd tea-rags-mcp-t5cji, L3-2) — the `this` twin of a
 * `super` call into an out-of-project base.
 *
 * Once `this` lost its exemption from the member-evidence guard,
 * `this.setState(...)` on a React class stopped landing on the project's lone
 * `setState` namesake and was charged to the `resolveSuccessRate` denominator as
 * a miss nothing can fix: taxdome's TS dynamic rate fell 0.8980 → 0.8815. React
 * declares the member, the default lib declares `hasOwnProperty`, and the
 * checker says so.
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
  "web/form.ts": [
    'import { Component } from "ui-pkg";',
    "export class Form extends Component<{ n: number }> {",
    "  submit(): boolean {",
    "    this.setState({ n: 1 });",
    '    return this.hasOwnProperty("n");',
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/job.ts": [
    'import { Base } from "./base";',
    "export class Job extends Base {",
    "  go(): number {",
    "    return this.inheritedRun();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/base.ts": ["export class Base {", "  inheritedRun(): number {", "    return 1;", "  }", "}", ""].join("\n"),
  // Unrelated project namesakes of the dependency's and the default lib's members.
  "web/store.ts": [
    "export class Store {",
    "  setState(): void {",
    "    return;",
    "  }",
    "}",
    "export class Registry {",
    "  hasOwnProperty(): boolean {",
    "    return false;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

/** A dependency the way a real project installs one — under its own root. */
const PACKAGE: Readonly<Record<string, string>> = {
  "node_modules/ui-pkg/package.json": JSON.stringify({ name: "ui-pkg", version: "1.0.0", types: "index.d.ts" }),
  "node_modules/ui-pkg/index.d.ts": ["export declare class Component<S> {", "  setState(next: S): void;", "}", ""].join(
    "\n",
  ),
};

interface RunStatsRow {
  attempted: number;
  resolved: number;
  external_skipped: number;
}

describe("a `this` member declared outside the project is external (bd tea-rags-mcp-t5cji)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ts-this-external-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ts-this-external-repo-"));
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

  it("counts `this` into a dependency and into the default lib as external, and still resolves a project base", async () => {
    const [row] = await client.queryAll<RunStatsRow>(
      "SELECT attempted, resolved, external_skipped FROM cg_run_stats WHERE language = 'typescript' AND receiver_kind = 'dynamic'",
    );
    expect({
      attempted: Number(row.attempted),
      resolved: Number(row.resolved),
      externalSkipped: Number(row.external_skipped),
    }).toEqual({ attempted: 3, resolved: 1, externalSkipped: 2 });
  });
});
