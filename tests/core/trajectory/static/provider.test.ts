import { describe, expect, it } from "vitest";

import { StaticPayloadBuilder } from "../../../../src/core/trajectory/static/provider.js";

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
});
