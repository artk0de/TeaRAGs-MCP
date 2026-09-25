/**
 * bd tea-rags-mcp-y5vx4 — an oversized symbol indexed as `#part1..#partN`
 * parts only: each later part opens with a context prefix (signature + the
 * opening rows of the blocks it sits in) that lies OUTSIDE its line range.
 * find_symbol must reassemble the symbol without repeating that prefix, and a
 * class outline must still list the split member.
 */

import { describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";

const PATH = "src/worker.ts";

function part(n: number, startLine: number, endLine: number, content: string) {
  return {
    id: `part-${n}`,
    payload: {
      symbolId: `Worker#run#part${n}`,
      parentSymbolId: "Worker#run",
      parentType: "method_definition",
      chunkType: "function",
      name: `run (part ${n}/3)`,
      relativePath: PATH,
      language: "typescript",
      startLine,
      endLine,
      content,
    },
  };
}

describe("resolveSymbols — statement-boundary split parts (bd tea-rags-mcp-y5vx4)", () => {
  const source = [
    "run(items) {", // 10
    "    let total = 0;", // 11
    "    for (const item of items) {", // 12
    "      total += item.a;", // 13
    "      total += item.b;", // 14
    "    }", // 15
    "    return total;", // 16
    "  }", // 17
  ];
  // Delivered out of order, as a Qdrant scroll does.
  const parts = [
    part(3, 15, 17, ["run(items) {", source[5], source[6], source[7]].join("\n")),
    part(1, 10, 13, source.slice(0, 4).join("\n")),
    part(2, 14, 14, ["run(items) {", "    for (const item of items) {", source[4]].join("\n")),
  ];

  it("drops each later part's context prefix and concatenates the rows back into the symbol", () => {
    const [result] = resolveSymbols(parts, "Worker#run");

    expect(result.payload?.symbolId).toBe("Worker#run");
    expect(result.payload?.name).toBe("run");
    expect(result.payload?.content).toBe(source.join("\n"));
    expect(result.payload?.startLine).toBe(10);
    expect(result.payload?.endLine).toBe(17);
    expect(result.payload?.mergedChunkIds).toEqual(["part-1", "part-2", "part-3"]);
  });

  it("joins character slices of one wide row without inserting a line break", () => {
    const wide = `const table = ${"x".repeat(40)};`;
    const slices = [
      part(1, 20, 20, wide.slice(0, 20)),
      part(2, 20, 20, `run(items) {\n${wide.slice(20, 40)}`),
      part(3, 20, 20, `run(items) {\n${wide.slice(40)}`),
    ];

    const [result] = resolveSymbols([slices[2], slices[0], slices[1]], "Worker#run");

    expect(result.payload?.content).toBe(wide);
  });

  it("a class outline lists a member indexed only as parts, once, under its base id", () => {
    const classChunk = {
      id: "cls",
      payload: {
        symbolId: "Worker",
        name: "Worker",
        chunkType: "class",
        relativePath: PATH,
        language: "typescript",
        startLine: 1,
        endLine: 30,
        content: "export class Worker {",
      },
    };

    const results = resolveSymbols([classChunk, ...parts], "Worker");

    expect(results).toHaveLength(1);
    const outline = String(results[0].payload?.content);
    expect(outline).toContain("Worker#run");
    expect(outline).not.toContain("#part");
  });
});
