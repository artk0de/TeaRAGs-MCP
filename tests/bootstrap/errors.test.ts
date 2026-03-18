import { describe, expect, it } from "vitest";

import { ConfigError, ConfigValueInvalidError, ConfigValueMissingError } from "../../src/bootstrap/errors.js";
import { TeaRagsError } from "../../src/core/infra/errors.js";

describe("ConfigError hierarchy", () => {
  describe("ConfigValueInvalidError", () => {
    const err = new ConfigValueInvalidError("embeddingProvider", "banana", "ollama | onnx | openai | cohere | voyage");

    it("is instanceof Error", () => {
      expect(err).toBeInstanceOf(Error);
    });

    it("is instanceof TeaRagsError", () => {
      expect(err).toBeInstanceOf(TeaRagsError);
    });

    it("is instanceof ConfigError", () => {
      expect(err).toBeInstanceOf(ConfigError);
    });

    it("has code CONFIG_VALUE_INVALID", () => {
      expect(err.code).toBe("CONFIG_VALUE_INVALID");
    });

    it("has httpStatus 400", () => {
      expect(err.httpStatus).toBe(400);
    });

    it("message includes field name and value", () => {
      expect(err.message).toContain("embeddingProvider");
      expect(err.message).toContain("banana");
    });

    it("hint includes expected values", () => {
      expect(err.hint).toContain("ollama | onnx | openai | cohere | voyage");
    });

    it("toUserMessage() includes field name", () => {
      const msg = err.toUserMessage();
      expect(msg).toContain("CONFIG_VALUE_INVALID");
      expect(msg).toContain("embeddingProvider");
    });
  });

  describe("ConfigValueMissingError", () => {
    const err = new ConfigValueMissingError("apiKey", "OPENAI_API_KEY");

    it("is instanceof Error", () => {
      expect(err).toBeInstanceOf(Error);
    });

    it("is instanceof TeaRagsError", () => {
      expect(err).toBeInstanceOf(TeaRagsError);
    });

    it("is instanceof ConfigError", () => {
      expect(err).toBeInstanceOf(ConfigError);
    });

    it("has code CONFIG_VALUE_MISSING", () => {
      expect(err.code).toBe("CONFIG_VALUE_MISSING");
    });

    it("has httpStatus 400", () => {
      expect(err.httpStatus).toBe(400);
    });

    it("message includes field name", () => {
      expect(err.message).toContain("apiKey");
    });

    it("hint includes env var name", () => {
      expect(err.hint).toContain("OPENAI_API_KEY");
    });

    it("toUserMessage() includes field name and env var", () => {
      const msg = err.toUserMessage();
      expect(msg).toContain("CONFIG_VALUE_MISSING");
      expect(msg).toContain("apiKey");
      expect(msg).toContain("OPENAI_API_KEY");
    });
  });
});
