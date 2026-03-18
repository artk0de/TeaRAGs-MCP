import { describe, expect, it } from "vitest";

import { TeaRagsError, UnknownError } from "../../../src/core/infra/errors.js";

describe("TeaRagsError", () => {
  // TeaRagsError is abstract, so we test via UnknownError (concrete subclass)

  describe("UnknownError", () => {
    it("is instanceof Error", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err).toBeInstanceOf(Error);
    });

    it("is instanceof TeaRagsError", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err).toBeInstanceOf(TeaRagsError);
    });

    it("has code UNKNOWN_ERROR", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err.code).toBe("UNKNOWN_ERROR");
    });

    it("has httpStatus 500", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err.httpStatus).toBe(500);
    });

    it("uses original error message", () => {
      const err = new UnknownError(new Error("something broke"));
      expect(err.message).toBe("something broke");
    });

    it("has default hint", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err.hint).toBe("Check server logs for details");
    });

    it("preserves cause chain", () => {
      const original = new Error("root cause");
      const err = new UnknownError(original);
      expect(err.cause).toBe(original);
    });

    it("handles non-Error cause", () => {
      const err = new UnknownError("string error");
      expect(err.message).toBe("string error");
      expect(err.cause).toBeUndefined();
    });

    it("handles null/undefined cause", () => {
      const err = new UnknownError(undefined);
      expect(err.message).toBe("An unknown error occurred");
      expect(err.cause).toBeUndefined();
    });
  });

  describe("toUserMessage()", () => {
    it("formats as [CODE] message with hint", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err.toUserMessage()).toBe("[UNKNOWN_ERROR] boom\n\nHint: Check server logs for details");
    });
  });

  describe("toString()", () => {
    it("formats as ClassName [CODE]: message", () => {
      const err = new UnknownError(new Error("boom"));
      expect(err.toString()).toBe("UnknownError [UNKNOWN_ERROR]: boom");
    });
  });
});
