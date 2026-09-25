import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import { fileScopeOf, reduceToFileScope } from "../../../../../src/core/domains/explore/chunk-grouping/file-scope.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { gitPayloadSignalDescriptors } from "../../../../../src/core/domains/trajectory/git/payload-signals.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../../../src/core/domains/trajectory/static/payload-signals.js";

/** The descriptor set production composes: static + git + codegraph. */
const PRODUCTION_SIGNALS: PayloadSignalDescriptor[] = [
  ...BASE_PAYLOAD_SIGNALS,
  ...gitPayloadSignalDescriptors,
  ...CODEGRAPH_SYMBOLS_FILE_SIGNALS,
  ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
];

/** A representative chunk payload exactly as the chunker + enrichment write it. */
function representativeChunkPayload(): Record<string, unknown> {
  return {
    content: "buildPayload(chunk) { … }",
    contentSize: 1968,
    codebasePath: "/repo",
    relativePath: "src/core/domains/trajectory/static/provider.ts",
    fileExtension: ".ts",
    language: "typescript",
    startLine: 7,
    endLine: 102,
    chunkIndex: 0,
    chunkType: "function",
    name: "buildPayload",
    parentSymbolId: "StaticPayloadBuilder",
    parentType: "class_declaration",
    symbolId: "StaticPayloadBuilder#buildPayload",
    isTest: true,
    isDocumentation: false,
    imports: ["node:path"],
    headingPath: [{ depth: 1, text: "Heading" }],
    navigation: { prevSymbolId: "A", nextSymbolId: "B" },
    methodLines: 57,
    methodDensity: 21,
    memberCount: 4,
    moduleLines: 65,
    moduleMethodCount: 1,
    git: {
      file: { commitCount: 6, ageDays: 50 },
      chunk: { commitCount: 2, ageDays: 10 },
    },
    codegraph: {
      symbols: {
        file: { fanIn: 1, fanOut: 1, instability: 0.5 },
        chunk: { fanIn: 1, pageRank: 0.0001 },
      },
    },
  };
}

describe("reduceToFileScope (bd tea-rags-mcp-mwq0k)", () => {
  const scope = fileScopeOf(PRODUCTION_SIGNALS);

  it("keeps exactly the file-level fields of a representative chunk payload", () => {
    expect(reduceToFileScope(representativeChunkPayload(), scope)).toEqual({
      relativePath: "src/core/domains/trajectory/static/provider.ts",
      fileExtension: ".ts",
      language: "typescript",
      isTest: true,
      isDocumentation: false,
      imports: ["node:path"],
      moduleLines: 65,
      moduleMethodCount: 1,
      git: { file: { commitCount: 6, ageDays: 50 } },
      codegraph: { symbols: { file: { fanIn: 1, fanOut: 1, instability: 0.5 } } },
    });
  });

  it("drops every chunk-scoped static field, including undeclared chunker keys and the body", () => {
    const reduced = reduceToFileScope(representativeChunkPayload(), scope);

    for (const key of [
      "startLine",
      "endLine",
      "chunkIndex",
      "chunkType",
      "name",
      "symbolId",
      "parentSymbolId",
      "parentType",
      "methodLines",
      "methodDensity",
      "memberCount",
      "contentSize",
      "navigation",
      "headingPath",
      "content",
      "members",
      "score",
    ]) {
      expect(reduced, key).not.toHaveProperty(key);
    }
  });

  it("drops the chunk branch of every trajectory namespace", () => {
    const reduced = reduceToFileScope(representativeChunkPayload(), scope);

    expect(reduced.git).not.toHaveProperty("chunk");
    expect((reduced.codegraph as { symbols: Record<string, unknown> }).symbols).not.toHaveProperty("chunk");
  });

  it("omits a namespace whose only branch was chunk-scoped", () => {
    const reduced = reduceToFileScope(
      { relativePath: "src/a.ts", git: { chunk: { commitCount: 1 } }, codegraph: { symbols: { chunk: { fanIn: 1 } } } },
      scope,
    );

    expect(reduced).toEqual({ relativePath: "src/a.ts" });
  });

  it("keeps relativePath — the file hit's identity — even with no descriptors declared", () => {
    const reduced = reduceToFileScope({ relativePath: "src/a.ts", name: "alpha", startLine: 1 }, fileScopeOf([]));

    expect(reduced).toEqual({ relativePath: "src/a.ts" });
  });

  it("derives file scope from descriptors: a flat key is file-level only when declared so", () => {
    const signals: PayloadSignalDescriptor[] = [
      { key: "ownerTeam", type: "string", description: "file owner", level: "file" },
      { key: "tokenCount", type: "number", description: "chunk tokens" },
    ];

    const reduced = reduceToFileScope(
      { relativePath: "a.ts", ownerTeam: "core", tokenCount: 12 },
      fileScopeOf(signals),
    );

    expect(reduced).toEqual({ relativePath: "a.ts", ownerTeam: "core" });
  });
});
