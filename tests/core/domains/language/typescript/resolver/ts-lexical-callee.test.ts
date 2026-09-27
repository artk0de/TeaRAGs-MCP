import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { tsNameOf } from "../../../../../../src/core/domains/language/typescript/index.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

/**
 * The symbols the REAL walker composes for `lines` — not hand-written ones. The
 * fix pins a local callee to the symbol the walker recorded for its declaration,
 * so the table must carry the walker's own ids (`main.send`, `parseSnapshot.close`)
 * or the test would only prove agreement with itself.
 */
function walkedSymbols(relPath: string, lines: string[]): NamedSymbol[] {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript);
  const root = materializeTree(parser.parse(src).rootNode, src);
  return collectSymbols({ rootNode: root }, tsNameOf, ".", false, new DefaultSymbolIdComposer()).map((range) => ({
    symbolId: range.symbolId,
    fqName: range.symbolId,
    shortName: range.symbolId.split(/[#.]/u).at(-1) ?? range.symbolId,
    relPath,
    scope: range.scope,
  }));
}

const ctxFor = (callerFile: string, symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable,
});

const bare = (member: string, startLine: number): CallRef => ({
  callText: `${member}()`,
  receiver: null,
  member,
  startLine,
});

/**
 * bd tea-rags-mcp-bv0tq — a bare call is bound by LEXICAL scope, never by a
 * short-name match over the file or the project.
 *
 * Live on tea-rags: `runIndexWorker(app, path, options, send)` calls its
 * PARAMETER `send(...)` seven times, and every one landed on `main.send` — the
 * function-scoped arrow `main` declares further down the same file — because
 * `sameFile` matches a bare callee against every short name the caller's file
 * declares. The existing local-callee guard sat only in `globalShortName`, one
 * pass too late. The converse is the same defect seen from the other side: a
 * function's OWN nested helper went unresolved as soon as a namesake existed
 * elsewhere in the file, because both short-name passes read a collision as
 * ambiguity instead of asking which declaration the identifier binds.
 */
describe("TSCallResolver — bare call bound by lexical scope (bd tea-rags-mcp-bv0tq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-lexical-callee-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const resolver = (): TSCallResolver => new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

  const tableFor = (relPath: string, lines: string[]): InMemoryGlobalSymbolTable => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile(relPath, walkedSymbols(relPath, lines));
    return table;
  };

  // The runIndexWorker shape: a parameter named like a function-scoped arrow
  // another function in the same file declares.
  const WORKER = [
    `export function runIndexWorker(send: (message: string) => void): void {`,
    `  send("start");`,
    `}`,
    ``,
    `export function main(): void {`,
    `  const send = (message: string): void => {`,
    `    void message;`,
    `  };`,
    `  runIndexWorker(send);`,
    `}`,
  ];

  it("emits no edge for a bare call on a PARAMETER that shares a same-file function's name (send -> main.send)", () => {
    writeSource(repoRoot, "src/worker.ts", WORKER);
    const table = tableFor("src/worker.ts", WORKER);
    expect(table.lookup("main.send")).toHaveLength(1);
    expect(resolver().resolve(bare("send", 2), ctxFor("src/worker.ts", table))).toBeNull();
  });

  // The installWorkerCrashGuard shape: the parameter is called from INSIDE a
  // nested closure, so the call's innermost function is not the one declaring it.
  const GUARD = [
    `export function installGuard(report: (origin: string) => void): () => void {`,
    `  return () => {`,
    `    report("uncaught");`,
    `  };`,
    `}`,
    ``,
    `export function boot(): void {`,
    `  const report = (origin: string): void => {`,
    `    void origin;`,
    `  };`,
    `  installGuard(report);`,
    `}`,
  ];

  it("emits no edge for a parameter called from a nested closure (report -> boot.report)", () => {
    writeSource(repoRoot, "src/guard.ts", GUARD);
    expect(resolver().resolve(bare("report", 3), ctxFor("src/guard.ts", tableFor("src/guard.ts", GUARD)))).toBeNull();
  });

  // A destructured parameter is a parameter too.
  const DESTRUCTURED = [
    `export function Row({ onRemove }: { onRemove: () => void }): void {`,
    `  onRemove();`,
    `}`,
    ``,
    `export function Panel(): void {`,
    `  const onRemove = (): void => {};`,
    `  Row({ onRemove });`,
    `}`,
  ];

  it("emits no edge for a destructured parameter (onRemove -> Panel.onRemove)", () => {
    writeSource(repoRoot, "src/row.ts", DESTRUCTURED);
    expect(
      resolver().resolve(bare("onRemove", 2), ctxFor("src/row.ts", tableFor("src/row.ts", DESTRUCTURED))),
    ).toBeNull();
  });

  // A non-function local: its value is whatever the expression holds, and a
  // same-file namesake is no evidence about that.
  const ALIASED_LOCAL = [
    `export function pick(flag: boolean, a: () => void, b: () => void): void {`,
    `  const run = flag ? a : b;`,
    `  run();`,
    `}`,
    ``,
    `export function other(): void {`,
    `  const run = (): void => {};`,
    `  run();`,
    `}`,
  ];

  it("emits no edge for a non-function local that shares a same-file function's name (run -> other.run)", () => {
    writeSource(repoRoot, "src/pick.ts", ALIASED_LOCAL);
    expect(
      resolver().resolve(bare("run", 3), ctxFor("src/pick.ts", tableFor("src/pick.ts", ALIASED_LOCAL))),
    ).toBeNull();
  });

  // Converse: the callee IS a function-valued declarator of the caller's own
  // scope, and a namesake elsewhere in the file made the short-name passes
  // read it as ambiguous.
  const OWN_ARROW = [
    `export function main(): void {`,
    `  const send = (message: string): void => {`,
    `    void message;`,
    `  };`,
    `  send("a");`,
    `}`,
    ``,
    `export function other(): void {`,
    `  const send = (message: string): void => {`,
    `    void message;`,
    `  };`,
    `  send("b");`,
    `}`,
  ];

  it("resolves a bare call to the function-valued const its OWN scope declares (other -> other.send)", () => {
    writeSource(repoRoot, "src/own.ts", OWN_ARROW);
    const table = tableFor("src/own.ts", OWN_ARROW);
    expect(resolver().resolve(bare("send", 12), ctxFor("src/own.ts", table))).toEqual({
      targetRelPath: "src/own.ts",
      targetSymbolId: "other.send",
    });
    expect(resolver().resolve(bare("send", 5), ctxFor("src/own.ts", table))).toEqual({
      targetRelPath: "src/own.ts",
      targetSymbolId: "main.send",
    });
  });

  const OWN_NESTED_FUNCTION = [
    `export function parseSnapshot(raw: string): string {`,
    `  function close(): string {`,
    `    return raw;`,
    `  }`,
    `  return close();`,
    `}`,
    ``,
    `export class Stream {`,
    `  close(): void {}`,
    `}`,
  ];

  it("resolves a bare call to its own NESTED function declaration despite a same-file namesake (close)", () => {
    writeSource(repoRoot, "src/snapshot.ts", OWN_NESTED_FUNCTION);
    expect(
      resolver().resolve(bare("close", 5), ctxFor("src/snapshot.ts", tableFor("src/snapshot.ts", OWN_NESTED_FUNCTION))),
    ).toEqual({ targetRelPath: "src/snapshot.ts", targetSymbolId: "parseSnapshot.close" });
  });

  // An enclosing (not innermost) scope's helper, called from a nested closure,
  // inside a class method — the walker composes `Widget#render.format`.
  const ENCLOSING_METHOD_SCOPE = [
    `export class Widget {`,
    `  render(items: string[]): string[] {`,
    `    const format = (item: string): string => item.trim();`,
    `    return items.map((item) => format(item));`,
    `  }`,
    `}`,
    ``,
    `export function format(value: number): string {`,
    `  return String(value);`,
    `}`,
  ];

  it("resolves a helper declared in an ENCLOSING method scope, called from a closure (Widget#render.format)", () => {
    writeSource(repoRoot, "src/widget.ts", ENCLOSING_METHOD_SCOPE);
    expect(
      resolver().resolve(bare("format", 4), ctxFor("src/widget.ts", tableFor("src/widget.ts", ENCLOSING_METHOD_SCOPE))),
    ).toEqual({ targetRelPath: "src/widget.ts", targetSymbolId: "Widget#render.format" });
  });

  // A local holding a CALL RESULT belongs to the checker tier, which follows the
  // value to the function-scoped arrow `start` returns. The row it names is
  // `start.shutdown`, found by scope once the file carries a second `shutdown`.
  const CALL_RESULT = [
    `function start() {`,
    `  const shutdown = (): void => {};`,
    `  return { shutdown };`,
    `}`,
    ``,
    `export function main(): void {`,
    `  const { shutdown } = start();`,
    `  shutdown();`,
    `}`,
    ``,
    `export function other(): void {`,
    `  const shutdown = (): void => {};`,
    `  shutdown();`,
    `}`,
  ];

  it("follows a call-result local to the nested arrow it holds, pinned by scope (shutdown -> start.shutdown)", () => {
    writeSource(repoRoot, "src/daemon.ts", CALL_RESULT);
    expect(
      resolver().resolve(bare("shutdown", 8), ctxFor("src/daemon.ts", tableFor("src/daemon.ts", CALL_RESULT))),
    ).toEqual({ targetRelPath: "src/daemon.ts", targetSymbolId: "start.shutdown" });
  });

  // Recall guard: a MODULE-LEVEL function is not a local binding and keeps the
  // edge the short-name passes give it.
  const MODULE_LEVEL = [
    `export function helper(): void {}`,
    ``,
    `export function caller(): void {`,
    `  helper();`,
    `}`,
  ];

  it("STILL resolves a bare call to a module-level function (the recall guard)", () => {
    writeSource(repoRoot, "src/module.ts", MODULE_LEVEL);
    expect(
      resolver().resolve(bare("helper", 4), ctxFor("src/module.ts", tableFor("src/module.ts", MODULE_LEVEL))),
    ).toEqual({ targetRelPath: "src/module.ts", targetSymbolId: "helper" });
  });

  it("behaves as before when the type checker is disabled (no Program, no lexical evidence)", () => {
    writeSource(repoRoot, "src/worker.ts", WORKER);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      expect(resolver().resolve(bare("send", 2), ctxFor("src/worker.ts", tableFor("src/worker.ts", WORKER)))).toEqual({
        targetRelPath: "src/worker.ts",
        targetSymbolId: "main.send",
      });
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
