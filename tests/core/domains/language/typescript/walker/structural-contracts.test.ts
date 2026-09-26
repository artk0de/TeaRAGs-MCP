/**
 * bd tea-rags-mcp-39xca.14 — the TypeScript walker declares its structural
 * contracts (interfaces and object type aliases, required callable members
 * only) and the positional arity of every method and function chunk, the two
 * facts the barrier matches to put structural implementers in the CHA cone.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";

interface ChunkRange {
  symbolId: string;
  scope: string[];
  startLine: number;
  endLine: number;
}

function extract(code: string, chunks: ChunkRange[] = []): FileExtraction {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return extractFromTypescriptFile({
    tree: parser.parse(code),
    code,
    relPath: "src/a.ts",
    language: "typescript",
    chunks,
  });
}

describe("TypeScript structural contracts (39xca.14)", () => {
  it("declares an interface's required methods and function-typed properties with their parameter counts", () => {
    const code = [
      "export interface Registry<T> extends Base {",
      "  find(id: string, opts?: Options): T;",
      "  maybe?(x: number): void;",
      "  list: (this: Registry<T>, limit: number) => T[];",
      "  optionalFn?: () => void;",
      "  size: number;",
      "  [key: string]: unknown;",
      "  (call: number): void;",
      "}",
    ].join("\n");

    expect(extract(code).structuralContracts).toEqual([
      {
        name: "Registry",
        members: [
          { name: "find", params: 2 },
          { name: "list", params: 1 },
        ],
      },
    ]);
  });

  it("declares an object type alias, and no alias of another shape", () => {
    const code = [
      "type Outcome = { isFullSuccess(): boolean; retry: (n: number) => void };",
      "type Id = string;",
      "type Fn = () => void;",
    ].join("\n");

    expect(extract(code).structuralContracts).toEqual([
      {
        name: "Outcome",
        members: [
          { name: "isFullSuccess", params: 0 },
          { name: "retry", params: 1 },
        ],
      },
    ]);
  });

  it("merges a re-opened interface's members into one declaration", () => {
    const code = ["interface Plugin { start(): void }", "interface Plugin { stop(force: boolean): void }"].join("\n");

    expect(extract(code).structuralContracts).toEqual([
      {
        name: "Plugin",
        members: [
          { name: "start", params: 0 },
          { name: "stop", params: 1 },
        ],
      },
    ]);
  });

  it("reads a rest parameter as accepting any count", () => {
    const code = "interface Logger { log(...parts: unknown[]): void }";

    expect(extract(code).structuralContracts).toEqual([
      { name: "Logger", members: [{ name: "log", params: Number.MAX_SAFE_INTEGER }] },
    ]);
  });

  it("declares no contract for an interface with no callable member, and none for a file without one", () => {
    expect(extract("interface Point { x: number; y: number }").structuralContracts).toBeUndefined();
    expect(extract("export const a = 1;").structuralContracts).toBeUndefined();
  });
});

describe("TypeScript callable arity (39xca.14)", () => {
  it("records minRequired / maxPositional / hasSplat on method and function chunks", () => {
    const code = [
      "class Store {", // 1
      "  put(key: string, value?: number, ...rest: unknown[]) {}", // 2
      "  get = (key: string, fallback = 0) => key;", // 3
      "}", // 4
      "function build(this: Store, a: number, b: number) {}", // 5
      "export const createX = () => ({", // 6
      "  isFullSuccess() { return [1].map((x) => x); },", // 7
      "  retry: (n: number) => n,", // 8
      "});", // 9
      "const single = x => x;", // 10
    ].join("\n");
    const extraction = extract(code, [
      { symbolId: "Store", scope: [], startLine: 1, endLine: 4 },
      { symbolId: "Store#put", scope: ["Store"], startLine: 2, endLine: 2 },
      { symbolId: "Store#get", scope: ["Store"], startLine: 3, endLine: 3 },
      { symbolId: "build", scope: [], startLine: 5, endLine: 5 },
      { symbolId: "createX", scope: [], startLine: 6, endLine: 9 },
      { symbolId: "createX.isFullSuccess", scope: ["createX"], startLine: 7, endLine: 7 },
      { symbolId: "createX.retry", scope: ["createX"], startLine: 8, endLine: 8 },
      { symbolId: "single", scope: [], startLine: 10, endLine: 10 },
    ]);
    const arity = Object.fromEntries(extraction.chunks.map((c) => [c.symbolId, c.arity]));

    expect(arity).toEqual({
      Store: undefined,
      "Store#put": { minRequired: 1, maxPositional: 2, hasSplat: true },
      "Store#get": { minRequired: 1, maxPositional: 2, hasSplat: false },
      build: { minRequired: 2, maxPositional: 2, hasSplat: false },
      createX: { minRequired: 0, maxPositional: 0, hasSplat: false },
      "createX.isFullSuccess": { minRequired: 0, maxPositional: 0, hasSplat: false },
      "createX.retry": { minRequired: 1, maxPositional: 1, hasSplat: false },
      single: { minRequired: 1, maxPositional: 1, hasSplat: false },
    });
  });
});
