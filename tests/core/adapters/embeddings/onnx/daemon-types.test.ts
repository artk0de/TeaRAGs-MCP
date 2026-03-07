import { describe, expect, it } from "vitest";
import {
  type DaemonRequest,
  type DaemonResponse,
  parseLine,
  serialize,
} from "../../../../../src/core/adapters/embeddings/onnx/daemon-types.js";

describe("daemon-types", () => {
  describe("serialize", () => {
    it("should append newline", () => {
      const msg: DaemonRequest = { type: "heartbeat" };
      expect(serialize(msg)).toBe('{"type":"heartbeat"}\n');
    });
  });

  describe("parseLine", () => {
    it("should parse valid JSON line", () => {
      const result = parseLine('{"type":"pong"}');
      expect(result).toEqual({ type: "pong" });
    });

    it("should return null for empty line", () => {
      expect(parseLine("")).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      expect(parseLine("{broken")).toBeNull();
    });
  });
});
