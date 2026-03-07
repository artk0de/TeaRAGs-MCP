import { describe, expect, it } from "vitest";

import { LANGUAGE_DEFINITIONS } from "../../../../../src/core/ingest/pipeline/chunker/config.js";

describe("LANGUAGE_DEFINITIONS", () => {
  describe("typescript extractLanguage", () => {
    it("returns mod.typescript when mod.default has no typescript property", () => {
      const extractLanguage = LANGUAGE_DEFINITIONS.typescript.extractLanguage!;
      const fakeLang = { parse: () => {} };
      // mod.default exists but does NOT have a "typescript" key
      const mod = { default: "not-an-object", typescript: fakeLang };

      const result = extractLanguage(mod as any);
      expect(result).toBe(fakeLang);
    });

    it("returns mod.default.typescript when mod.default is an object with typescript key", () => {
      const extractLanguage = LANGUAGE_DEFINITIONS.typescript.extractLanguage!;
      const fakeLang = { parse: () => {} };
      const mod = { default: { typescript: fakeLang } };

      const result = extractLanguage(mod as any);
      expect(result).toBe(fakeLang);
    });
  });

  describe("markdown loadModule", () => {
    it("resolves to null", async () => {
      const result = await LANGUAGE_DEFINITIONS.markdown.loadModule();
      expect(result).toBeNull();
    });
  });
});
