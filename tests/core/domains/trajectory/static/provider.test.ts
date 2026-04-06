import { describe, expect, it } from "vitest";

import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

describe("StaticPayloadBuilder", () => {
  const builder = new StaticPayloadBuilder();

  const chunk = {
    content: "function hello() { return 1; }",
    startLine: 10,
    endLine: 20,
    metadata: {
      filePath: "/project/src/hello.ts",
      language: "typescript",
      chunkIndex: 0,
      chunkType: "function",
      name: "hello",
      symbolId: "hello",
      methodLines: 10,
    } as Record<string, unknown>,
  };

  it("builds payload with all base fields", () => {
    const payload = builder.buildPayload(chunk, "/project");
    expect(payload.content).toBe(chunk.content);
    expect(payload.contentSize).toBe(chunk.content.length);
    expect(payload.relativePath).toBe("src/hello.ts");
    expect(payload.startLine).toBe(10);
    expect(payload.endLine).toBe(20);
    expect(payload.language).toBe("typescript");
    expect(payload.chunkType).toBe("function");
    expect(payload.name).toBe("hello");
    expect(payload.symbolId).toBe("hello");
  });

  it("computes methodDensity from content and methodLines", () => {
    const payload = builder.buildPayload(chunk, "/project");
    expect(payload.methodLines).toBe(10);
    expect(payload.methodDensity).toBe(Math.round(chunk.content.length / 10));
  });

  it("omits optional fields when not present", () => {
    const minimal = {
      content: "x",
      startLine: 1,
      endLine: 1,
      metadata: { filePath: "/project/a.ts", language: "typescript", chunkIndex: 0 } as Record<string, unknown>,
    };
    const payload = builder.buildPayload(minimal, "/project");
    expect(payload.name).toBeUndefined();
    expect(payload.methodLines).toBeUndefined();
    expect(payload.methodDensity).toBeUndefined();
  });

  it("writes parentSymbolId, parentType, and imports to payload", () => {
    const richChunk = {
      content: "class method body",
      startLine: 5,
      endLine: 15,
      metadata: {
        filePath: "/project/src/service.ts",
        language: "typescript",
        chunkIndex: 1,
        parentSymbolId: "MyService",
        parentType: "class",
        imports: ["./utils.js", "./types.js"],
      } as Record<string, unknown>,
    };
    const payload = builder.buildPayload(richChunk, "/project");
    expect(payload.parentSymbolId).toBe("MyService");
    expect(payload.parentType).toBe("class");
    expect(payload.imports).toEqual(["./utils.js", "./types.js"]);
  });

  it("writes navigation to payload", () => {
    const navChunk = {
      content: "test",
      startLine: 1,
      endLine: 5,
      metadata: {
        filePath: "/project/src/app.ts",
        language: "typescript",
        chunkIndex: 0,
        symbolId: "App#run",
        navigation: { prevSymbolId: "App#init", nextSymbolId: "App#stop" },
      } as Record<string, unknown>,
    };

    const payload = builder.buildPayload(navChunk, "/project");

    expect(payload.navigation).toEqual({
      prevSymbolId: "App#init",
      nextSymbolId: "App#stop",
    });
  });

  it("writes headingPath to payload for documentation chunks", () => {
    const docChunk = {
      content: "# Auth\nSome content",
      startLine: 1,
      endLine: 5,
      metadata: {
        filePath: "/project/docs/api.md",
        language: "markdown",
        chunkIndex: 0,
        isDocumentation: true,
        headingPath: [
          { depth: 1, text: "API" },
          { depth: 2, text: "Auth" },
        ],
      } as Record<string, unknown>,
    };

    const payload = builder.buildPayload(docChunk, "/project");

    expect(payload.headingPath).toEqual([
      { depth: 1, text: "API" },
      { depth: 2, text: "Auth" },
    ]);
  });

  it("omits navigation from payload when not present", () => {
    const noNavChunk = {
      content: "test",
      startLine: 1,
      endLine: 5,
      metadata: {
        filePath: "/project/src/app.ts",
        language: "typescript",
        chunkIndex: 0,
      } as Record<string, unknown>,
    };

    const payload = builder.buildPayload(noNavChunk, "/project");

    expect(payload.navigation).toBeUndefined();
  });

  it("sets isTest for test files", () => {
    const testChunk = {
      content: "test code",
      startLine: 1,
      endLine: 5,
      metadata: {
        filePath: "/project/tests/utils.test.ts",
        language: "typescript",
        chunkIndex: 0,
      } as Record<string, unknown>,
    };
    const payload = builder.buildPayload(testChunk, "/project");
    expect(payload.isTest).toBe(true);
  });

  it("omits isTest for non-test files", () => {
    const payload = builder.buildPayload(chunk, "/project");
    expect(payload.isTest).toBeUndefined();
  });
});
