/**
 * `.call` / `.apply` / `.bind` on a receiver that is NOT a function
 * (bd tea-rags-mcp-g7h1y).
 *
 * The walker unwraps `f.call(obj)` to the function `f` it invokes (bd
 * tea-rags-mcp-f2u54). That reading is only true when `f` is a function. On a
 * fresh codegraph of this repo every `this.connection.call(async () => …)` site
 * — `connection` a parameter property typed `QdrantConnection`, whose class
 * declares a real `call` method — produced NO edge: the walker rewrote it to
 * `this.connection` as if the field were the function, and the literal
 * `QdrantConnection#call` edge was dropped.
 *
 * End to end, walker → resolver, over files on disk so the checker tier is
 * live exactly as it is in production.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ChunkExtraction,
  FileExtraction,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface ChunkSpec {
  symbolId: string;
  startLine: number;
  endLine: number;
  scope: string[];
}

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return parser.parse(code);
}

describe("TS call/apply/bind on a non-function receiver (bd tea-rags-mcp-g7h1y)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-invoker-receiver-")));
    writeFileSync(join(repoRoot, "tsconfig.json"), `{ "include": ["src/**/*"] }\n`, "utf8");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function extract(relPath: string, lines: string[], chunks: ChunkSpec[]): FileExtraction {
    const code = lines.join("\n");
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, code, "utf8");
    return extractFromTypescriptFile({ tree: parse(code), code, relPath, language: "typescript", chunks });
  }

  function symbolTableOf(files: FileExtraction[]): InMemoryGlobalSymbolTable {
    const table = new InMemoryGlobalSymbolTable();
    for (const file of files) {
      table.upsertFile(
        file.relPath,
        file.chunks.map((c) => ({
          symbolId: c.symbolId,
          fqName: c.symbolId,
          shortName: c.symbolId.split(/[#.]/).pop() ?? c.symbolId,
          relPath: file.relPath,
          scope: c.scope,
        })),
      );
    }
    return table;
  }

  /** Resolve every call of `chunkId` in `file`; returns the target symbol ids. */
  function resolveChunk(file: FileExtraction, chunkId: string, all: FileExtraction[]): (string | null)[] {
    const chunk = file.chunks.find((c) => c.symbolId === chunkId) as ChunkExtraction;
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);
    const ctx: CallContext = {
      callerFile: file.relPath,
      callerScope: chunk.scope,
      imports: file.imports,
      symbolTable: symbolTableOf(all),
      classFieldTypes: file.classFieldTypes,
      classExtends: file.classExtends,
      localBindings: chunk.localBindings,
      projectRoot: repoRoot,
    };
    return chunk.calls.map((call: CallRef) => resolver.resolve(call, ctx)?.targetSymbolId ?? null);
  }

  it("walker keeps ONE ref per site: the unwrapped function, carrying the literal invoker", () => {
    const file = extract(
      "src/site.ts",
      ["export function go(): void {", "  this.c.call(fn);", "  helper.bind(obj);", "}", ""],
      [{ symbolId: "go", startLine: 1, endLine: 4, scope: [] }],
    );

    expect(file.chunks[0].calls).toEqual([
      expect.objectContaining({
        receiver: "this",
        member: "c",
        functionInvokerSite: { receiver: "this.c", member: "call" },
      }),
      expect.objectContaining({
        receiver: null,
        member: "helper",
        functionInvokerSite: { receiver: "helper", member: "bind" },
      }),
    ]);
  });

  it("resolves `this.c.call(fn)` to Conn#call when the parameter property's class declares `call`", () => {
    const file = extract(
      "src/user.ts",
      [
        "export class Conn {",
        "  call<T>(fn: () => T): T {",
        "    return fn();",
        "  }",
        "}",
        "export class User {",
        "  constructor(private readonly c: Conn) {}",
        "  run(): number {",
        "    return this.c.call(() => 1);",
        "  }",
        "}",
        "",
      ],
      [
        { symbolId: "Conn#call", startLine: 2, endLine: 4, scope: ["Conn"] },
        { symbolId: "User#run", startLine: 8, endLine: 10, scope: ["User"] },
      ],
    );

    expect(resolveChunk(file, "User#run", [file])).toContain("Conn#call");
  });

  it("resolves the collaborator site across files — the QdrantConnection shape", () => {
    const conn = extract(
      "src/connection.ts",
      [
        "export class Conn {",
        "  async call<T>(fn: () => Promise<T>): Promise<T> {",
        "    return fn();",
        "  }",
        "}",
        "",
      ],
      [{ symbolId: "Conn#call", startLine: 2, endLine: 4, scope: ["Conn"] }],
    );
    const store = extract(
      "src/store.ts",
      [
        'import type { Conn } from "./connection.js";',
        "export class Store {",
        "  constructor(private readonly connection: Conn) {}",
        "  async write(): Promise<void> {",
        "    await this.connection.call(async () => undefined);",
        "  }",
        "}",
        "",
      ],
      [{ symbolId: "Store#write", startLine: 4, endLine: 6, scope: ["Store"] }],
    );

    expect(resolveChunk(store, "Store#write", [conn, store])).toContain("Conn#call");
  });

  it("resolves `c.apply(x)` on a typed parameter whose class declares `apply`", () => {
    const file = extract(
      "src/patch.ts",
      [
        "export class Patch {",
        "  apply(target: object): void {}",
        "}",
        "export function run(p: Patch, t: object): void {",
        "  p.apply(t);",
        "}",
        "",
      ],
      [
        { symbolId: "Patch#apply", startLine: 2, endLine: 2, scope: ["Patch"] },
        { symbolId: "run", startLine: 4, endLine: 6, scope: [] },
      ],
    );

    expect(resolveChunk(file, "run", [file])).toContain("Patch#apply");
  });

  it("still unwraps `fn.call(obj)` / `fn.apply` / `fn.bind` on a real function", () => {
    const file = extract(
      "src/fn.ts",
      [
        "export class Conn {",
        "  call(): void {}",
        "}",
        "export function helper(this: unknown): void {}",
        "export function go(obj: object): void {",
        "  helper.call(obj);",
        "  helper.apply(obj, []);",
        "  const bound = helper.bind(obj);",
        "}",
        "",
      ],
      [
        { symbolId: "Conn#call", startLine: 2, endLine: 2, scope: ["Conn"] },
        { symbolId: "helper", startLine: 4, endLine: 4, scope: [] },
        { symbolId: "go", startLine: 5, endLine: 9, scope: [] },
      ],
    );

    expect(resolveChunk(file, "go", [file])).toEqual(["helper", "helper", "helper"]);
  });

  it("unwraps a function-typed field and never retargets it to a project `call` method", () => {
    const file = extract(
      "src/timer.ts",
      [
        "export class Conn {",
        "  call(): void {}",
        "}",
        "export class Timer {",
        "  private handler: () => void = () => undefined;",
        "  tick(): void {}",
        "  go(args: unknown[]): void {",
        "    this.handler.call(this);",
        "    this.tick.apply(this, args);",
        "  }",
        "}",
        "",
      ],
      [
        { symbolId: "Conn#call", startLine: 2, endLine: 2, scope: ["Conn"] },
        { symbolId: "Timer#tick", startLine: 6, endLine: 6, scope: ["Timer"] },
        { symbolId: "Timer#go", startLine: 7, endLine: 10, scope: ["Timer"] },
      ],
    );

    const targets = resolveChunk(file, "Timer#go", [file]);
    expect(targets).not.toContain("Conn#call");
    expect(targets).toContain("Timer#tick");
  });
});
