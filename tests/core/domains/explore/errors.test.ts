import { describe, expect, it } from "vitest";

import {
  CollectionNotFoundError,
  ExploreError,
  HybridNotEnabledError,
  InvalidQueryError,
} from "../../../../src/core/domains/explore/errors.js";
import { TeaRagsError } from "../../../../src/core/infra/errors.js";

describe("ExploreError hierarchy", () => {
  describe("ExploreError (abstract)", () => {
    it("cannot be instantiated directly", () => {
      const err = new CollectionNotFoundError("col");
      expect(err).toBeInstanceOf(ExploreError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("CollectionNotFoundError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new CollectionNotFoundError("code_abc123");
      expect(err.code).toBe("EXPLORE_COLLECTION_NOT_FOUND");
      expect(err.httpStatus).toBe(404);
      expect(err.message).toContain("code_abc123");
      expect(err.name).toBe("CollectionNotFoundError");
    });

    it("instanceof chain is correct", () => {
      const err = new CollectionNotFoundError("col");
      expect(err).toBeInstanceOf(CollectionNotFoundError);
      expect(err).toBeInstanceOf(ExploreError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });

    it("toUserMessage() includes code and hint", () => {
      const err = new CollectionNotFoundError("col");
      const msg = err.toUserMessage();
      expect(msg).toContain("EXPLORE_COLLECTION_NOT_FOUND");
      expect(msg).toContain("Hint:");
    });
  });

  describe("HybridNotEnabledError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new HybridNotEnabledError("code_abc123");
      expect(err.code).toBe("EXPLORE_HYBRID_NOT_ENABLED");
      expect(err.httpStatus).toBe(400);
      expect(err.message).toContain("code_abc123");
      expect(err.name).toBe("HybridNotEnabledError");
    });

    it("instanceof chain is correct", () => {
      const err = new HybridNotEnabledError("col");
      expect(err).toBeInstanceOf(HybridNotEnabledError);
      expect(err).toBeInstanceOf(ExploreError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("InvalidQueryError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new InvalidQueryError("Query must not be empty");
      expect(err.code).toBe("EXPLORE_INVALID_QUERY");
      expect(err.httpStatus).toBe(400);
      expect(err.message).toContain("Query must not be empty");
      expect(err.name).toBe("InvalidQueryError");
    });

    it("instanceof chain is correct", () => {
      const err = new InvalidQueryError("bad");
      expect(err).toBeInstanceOf(InvalidQueryError);
      expect(err).toBeInstanceOf(ExploreError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
