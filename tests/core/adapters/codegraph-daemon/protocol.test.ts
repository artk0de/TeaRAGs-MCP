import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrames,
  type DaemonRequest,
  type DaemonResponse,
} from "../../../../src/core/adapters/codegraph-daemon/protocol.js";

describe("daemon protocol framing", () => {
  it("round-trips a request through encode → decode", () => {
    const req: DaemonRequest = {
      id: 7,
      op: "upsertFile",
      params: {
        collection: "code_x_v1",
        node: { relPath: "a.ts", language: "typescript" },
        edges: { fileEdges: [], methodEdges: [] },
      },
    };
    const { frames, rest } = decodeFrames(encodeFrame(req));
    expect(rest).toBe("");
    expect(JSON.parse(frames[0])).toEqual(req);
  });

  it("decodes multiple frames and leaves a partial tail in rest", () => {
    const a = encodeFrame({ id: 1, op: "checkpoint", params: { collection: "c" } } as DaemonRequest);
    const b = encodeFrame({ id: 2, op: "checkpoint", params: { collection: "c" } } as DaemonRequest);
    const buf = a + b.slice(0, b.length - 3); // truncate second frame
    const { frames, rest } = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(rest).toBe(b.slice(0, b.length - 3));
  });

  it("round-trips a read request (getCallers) through encode → decode", () => {
    const req: DaemonRequest = {
      id: 11,
      op: "getCallers",
      params: { collection: "code_x_v1", symbolId: "Foo#bar" },
    };
    const { frames, rest } = decodeFrames(encodeFrame(req));
    expect(rest).toBe("");
    expect(JSON.parse(frames[0])).toEqual(req);
  });

  it("round-trips a findCycles read request with a scope param", () => {
    const req: DaemonRequest = {
      id: 12,
      op: "findCycles",
      params: { collection: "code_x_v1", scope: "file" },
    };
    const { frames } = decodeFrames(encodeFrame(req));
    expect(JSON.parse(frames[0])).toEqual(req);
  });

  it("response carries ok | error discriminant", () => {
    const ok: DaemonResponse = { id: 1, ok: true, result: null };
    const err: DaemonResponse = { id: 2, ok: false, error: { name: "CodegraphResolveError", message: "boom" } };
    expect(JSON.parse(decodeFrames(encodeFrame(ok)).frames[0]).ok).toBe(true);
    expect(JSON.parse(decodeFrames(encodeFrame(err)).frames[0]).ok).toBe(false);
  });
});
