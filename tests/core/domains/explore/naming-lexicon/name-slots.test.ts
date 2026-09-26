import { describe, expect, it } from "vitest";

import { splitNameSlots } from "../../../../../src/core/domains/explore/naming-lexicon/name-slots.js";

describe("splitNameSlots", () => {
  it("splits head and qualifiers by the project's known heads", () => {
    expect(splitNameSlots("CalculatedDocument", new Set(["document", "doc"]))).toEqual({
      head: ["document"],
      qualifiers: ["calculated"],
    });
  });

  it("takes the longest known trailing phrase as the head", () => {
    expect(splitNameSlots("CachedFileSignals", new Set(["signals", "file signals"]))).toEqual({
      head: ["file", "signals"],
      qualifiers: ["cached"],
    });
  });

  it("falls back to the last word when no head is known", () => {
    expect(splitNameSlots("calculatedDoc", new Set())).toEqual({ head: ["doc"], qualifiers: ["calculated"] });
  });

  it("reads the last namespace segment of a qualified type name", () => {
    expect(splitNameSlots("Billing::PredefinedTemplate", new Set(["template"]))).toEqual({
      head: ["template"],
      qualifiers: ["predefined"],
    });
  });

  it("a name with no words has empty slots", () => {
    expect(splitNameSlots("__", new Set())).toEqual({ head: [], qualifiers: [] });
  });
});
