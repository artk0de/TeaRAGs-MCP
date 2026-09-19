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

/**
 * With NO Program (`CODEGRAPH_TS_TYPECHECKER=0`, or heap admission's
 * `typecheckerOff`) the checker's agreement cannot be had, and the only evidence
 * left is structural: the receiver is an import binding whose module — through
 * its barrel — declares the candidate, or it is `this` and the candidate is what
 * its class or a file-anchored base declares (bd tea-rags-mcp-t5cji). A value no
 * import binds stays declined, as it does with the checker on, and so does a
 * `this` member only a namesake of the base declares.
 */
describe("TS member calls with the checker OFF take structural evidence only (bd tea-rags-mcp-t5cji)", () => {
  const NO_CHECKER_CORPUS: Readonly<Record<string, string>> = {
    "web/helpers/foo-helper.ts": ["export function fooHelperFn(): number {", "  return 1;", "}", ""].join("\n"),
    "web/helpers/index.ts": ['export { fooHelperFn } from "./foo-helper";', ""].join("\n"),
    "web/ns-caller.ts": [
      'import * as H from "./helpers";',
      "export function viaNamespace(): number {",
      "  return H.fooHelperFn();",
      "}",
      "export function viaValue(box: any): number {",
      "  return box.fooHelperFn();",
      "}",
      "",
    ].join("\n"),
    "web/jobs/base-job.ts": [
      "export class BaseJob {",
      "  retryLater(): number {",
      "    return 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    // A namesake of the base in another package, declaring what the real base does not.
    "web/other/base-job.ts": [
      "export class BaseJob {",
      "  archiveNow(): number {",
      "    return 3;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "web/jobs/export-job.ts": [
      'import { BaseJob } from "./base-job";',
      "export class ExportJob extends BaseJob {",
      // With an explicit constructor a field initializer stays in the CLASS-BODY
      // chunk: empty scope, the class itself as the chunk's id.
      "  private readonly hooks = { done: (): number => this.cleanupNow() };",
      "  constructor() {",
      "    super();",
      "  }",
      "  run(): number {",
      "    return this.retryLater() + this.archiveNow() + this.hooks.done();",
      "  }",
      "  cleanupNow(): number {",
      "    return 2;",
      "  }",
      "}",
      "",
    ].join("\n"),
  };

  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let previousTypechecker: string | undefined;

  beforeEach(async () => {
    previousTypechecker = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    tmp = mkdtempSync(join(tmpdir(), "cg-ts-member-evidence-off-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ts-member-evidence-off-repo-"));
    for (const [relPath, source] of Object.entries(NO_CHECKER_CORPUS)) {
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
    const batch = await provider.extractFileBatch(root, Object.keys(NO_CHECKER_CORPUS).sort());
    await provider.absorbExtractedFiles(root, batch.extractions);
    await provider.finalizeSignals(root);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    if (previousTypechecker === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
    else process.env.CODEGRAPH_TS_TYPECHECKER = previousTypechecker;
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

  it("resolves a namespace-import member through the barrel to the file that declares it", async () => {
    expect(await targetsOf("H.fooHelperFn()")).toEqual(["web/helpers/foo-helper.ts::fooHelperFn"]);
  });

  it("still declines the same member on a value no import binds", async () => {
    expect(await targetsOf("box.fooHelperFn()")).toEqual([]);
  });

  it("resolves a `this` member inherited from the base the caller's file imports", async () => {
    expect(await targetsOf("this.retryLater()")).toEqual(["web/jobs/base-job.ts::BaseJob#retryLater"]);
  });

  it("resolves a class-body `this` member to the enclosing class's own method", async () => {
    expect(await targetsOf("this.cleanupNow()")).toEqual(["web/jobs/export-job.ts::ExportJob#cleanupNow"]);
  });

  it("declines a `this` member only a namesake of the base declares", async () => {
    expect(await targetsOf("this.archiveNow()")).toEqual([]);
  });
});

/**
 * The REAL interface-typed parameter (bd tea-rags-mcp-2qp6, re-validator probe
 * C14). A TypeScript `interface` never enters the symbol table — `tsNameOf`
 * does not name `interface_declaration` — so the walker's `h: Handler2`
 * binding is not the evidence the short-name passes' abstract-class fixtures
 * model. What answers it is the CHA cone, which runs before the chain: the
 * walker-bound interface is the base type, the run hierarchy's `implements`
 * edges are the cone, and every implementer gets an edge — including the one
 * the caller never imports.
 */
describe("an interface-typed parameter dispatches through the cone to every implementer (bd tea-rags-mcp-2qp6)", () => {
  const INTERFACE_CORPUS: Readonly<Record<string, string>> = {
    "web/res/contract.ts": ["export interface Handler2 {", "  handleIt(x: number): number;", "}", ""].join("\n"),
    "web/res/impl-a.ts": [
      'import type { Handler2 } from "./contract";',
      "export class ImplA implements Handler2 {",
      "  handleIt(x: number): number {",
      "    return x;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "web/res/impl-b.ts": [
      'import type { Handler2 } from "./contract";',
      "export class ImplB implements Handler2 {",
      "  handleIt(x: number): number {",
      "    return x + 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "web/res/caller.ts": [
      'import type { Handler2 } from "./contract";',
      'import { ImplA } from "./impl-a";',
      "export function cFourteen(h: Handler2): number {",
      "  void ImplA;",
      "  return h.handleIt(1);",
      "}",
      "",
    ].join("\n"),
  };

  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ts-interface-param-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-ts-interface-param-repo-"));
    for (const [relPath, source] of Object.entries(INTERFACE_CORPUS)) {
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
    const batch = await provider.extractFileBatch(root, Object.keys(INTERFACE_CORPUS).sort());
    await provider.absorbExtractedFiles(root, batch.extractions);
    await provider.finalizeSignals(root);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("emits a cone edge to each implementer, not just the imported one", async () => {
    const rows = await client.queryAll<MethodEdgeRow & { edge_kind: string; confidence: number }>(
      "SELECT source_symbol_id, call_expression, target_rel_path, target_symbol_id, edge_kind, confidence FROM cg_symbols_edges_method",
    );
    const edges = rows
      .filter((edge) => edge.call_expression === "h.handleIt(1)")
      .map((edge) => `${edge.target_rel_path}::${edge.target_symbol_id ?? ""} ${edge.edge_kind}`)
      .sort();
    expect(edges).toEqual(["web/res/impl-a.ts::ImplA#handleIt cone", "web/res/impl-b.ts::ImplB#handleIt cone"]);
  });
});
