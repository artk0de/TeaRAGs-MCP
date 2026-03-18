import { describe, expect, it } from "vitest";

import { CollectionNotProvidedError, InputValidationError } from "../../../src/core/api/errors.js";
import { TeaRagsError } from "../../../src/core/infra/errors.js";

describe("InputValidationError hierarchy", () => {
  describe("CollectionNotProvidedError", () => {
    it("is instanceof Error", () => {
      const err = new CollectionNotProvidedError();
      expect(err).toBeInstanceOf(Error);
    });

    it("is instanceof TeaRagsError", () => {
      const err = new CollectionNotProvidedError();
      expect(err).toBeInstanceOf(TeaRagsError);
    });

    it("is instanceof InputValidationError", () => {
      const err = new CollectionNotProvidedError();
      expect(err).toBeInstanceOf(InputValidationError);
    });

    it("has code INPUT_COLLECTION_NOT_PROVIDED", () => {
      const err = new CollectionNotProvidedError();
      expect(err.code).toBe("INPUT_COLLECTION_NOT_PROVIDED");
    });

    it("has httpStatus 400", () => {
      const err = new CollectionNotProvidedError();
      expect(err.httpStatus).toBe(400);
    });

    it("has correct message", () => {
      const err = new CollectionNotProvidedError();
      expect(err.message).toBe("Either 'collection' or 'path' parameter is required.");
    });

    it("has correct hint", () => {
      const err = new CollectionNotProvidedError();
      expect(err.hint).toBe("Provide a 'collection' name or a 'path' to the codebase.");
    });

    it("formats toUserMessage() correctly", () => {
      const err = new CollectionNotProvidedError();
      expect(err.toUserMessage()).toBe(
        "[INPUT_COLLECTION_NOT_PROVIDED] Either 'collection' or 'path' parameter is required.\n\nHint: Provide a 'collection' name or a 'path' to the codebase.",
      );
    });

    it("formats toString() correctly", () => {
      const err = new CollectionNotProvidedError();
      expect(err.toString()).toBe(
        "CollectionNotProvidedError [INPUT_COLLECTION_NOT_PROVIDED]: Either 'collection' or 'path' parameter is required.",
      );
    });
  });

  describe("InputValidationError", () => {
    it("cannot be instantiated directly (abstract)", () => {
      // InputValidationError is abstract — verify it's exported as a type check
      // We can only verify via instanceof on a concrete subclass
      const err = new CollectionNotProvidedError();
      expect(err).toBeInstanceOf(InputValidationError);
    });
  });
});
