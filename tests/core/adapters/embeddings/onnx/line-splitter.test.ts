import { describe, expect, it } from "vitest";

import { LineSplitter } from "../../../../../src/core/adapters/embeddings/onnx/line-splitter.js";

describe("LineSplitter", () => {
  it("should emit complete lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('{"type":"pong"}\n');
    expect(lines).toEqual(['{"type":"pong"}']);
  });

  it("should buffer partial lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('{"type":');
    expect(lines).toEqual([]);

    splitter.feed('"pong"}\n');
    expect(lines).toEqual(['{"type":"pong"}']);
  });

  it("should handle multiple lines in one chunk", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("should skip empty lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('\n\n{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });
});
