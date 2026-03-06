import { describe, expect, it } from "vitest";

describe("chunk-pipeline payload: methodLines and methodDensity", () => {
  it("computes methodDensity as contentSize / methodLines", () => {
    const content = "x".repeat(600); // 600 chars
    const methodLines = 10;
    const methodDensity = Math.round(content.length / methodLines);
    expect(methodDensity).toBe(60); // 600 / 10 = 60 chars/line
  });

  it("both fields present when methodLines is set", () => {
    const chunk = {
      content: "x".repeat(1000),
      metadata: { methodLines: 25 },
    };
    const payload: Record<string, unknown> = {
      ...(chunk.metadata.methodLines && {
        methodLines: chunk.metadata.methodLines,
        methodDensity: Math.round(chunk.content.length / chunk.metadata.methodLines),
      }),
    };
    expect(payload.methodLines).toBe(25);
    expect(payload.methodDensity).toBe(40); // 1000 / 25 = 40
  });

  it("both fields absent when methodLines is not set", () => {
    const chunk = {
      content: "some code",
      metadata: {} as Record<string, unknown>,
    };
    const payload: Record<string, unknown> = {
      ...(chunk.metadata.methodLines && {
        methodLines: chunk.metadata.methodLines,
        methodDensity: Math.round(chunk.content.length / (chunk.metadata.methodLines as number)),
      }),
    };
    expect(payload.methodLines).toBeUndefined();
    expect(payload.methodDensity).toBeUndefined();
  });
});
