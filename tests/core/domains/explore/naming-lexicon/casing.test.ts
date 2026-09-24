import { describe, expect, it } from "vitest";

import {
  detectIdentifierCasing,
  joinIdentifierWords,
  pluralizeIdentifierWord,
  renderIdentifier,
  renderIdentifierPlural,
  singularizeIdentifierWord,
  splitIdentifierWords,
  stripIdentifierDecorations,
} from "../../../../../src/core/domains/explore/naming-lexicon/casing.js";

/**
 * Casing is a parameter, never a language lookup: the ops layer reads the
 * canonical casing per role from the language descriptor and passes it in.
 */
describe("splitIdentifierWords", () => {
  it.each([
    ["find_tax_automation_document!", ["find", "tax", "automation", "document"]],
    ["taxAutomationDocument", ["tax", "automation", "document"]],
    ["TaxAutomationDocument", ["tax", "automation", "document"]],
    ["TAX_AUTOMATION_DOCUMENT", ["tax", "automation", "document"]],
    ["@document", ["document"]],
    ["@@registry", ["registry"]],
    ["$stdout", ["stdout"]],
    ["self.owner", ["owner"]],
    ["valid?", ["valid"]],
    ["TaxPreparation::TaxAutomations::Document#find", ["tax", "preparation", "tax", "automations", "document", "find"]],
    ["HTTPServer", ["http", "server"]],
    ["SHA256Digest", ["sha256", "digest"]],
    ["base64", ["base64"]],
  ])("%s → %j", (identifier, words) => {
    expect(splitIdentifierWords(identifier)).toEqual(words);
  });

  it("returns no words for an empty or punctuation-only identifier", () => {
    expect(splitIdentifierWords("")).toEqual([]);
    expect(splitIdentifierWords("!?")).toEqual([]);
  });
});

describe("stripIdentifierDecorations", () => {
  it.each([
    ["@document", "document"],
    ["@@count", "count"],
    ["$global", "global"],
    ["self.name", "name"],
    ["save!", "save"],
    ["valid?", "valid"],
    ["plain", "plain"],
  ])("%s → %s", (name, stripped) => {
    expect(stripIdentifierDecorations(name)).toBe(stripped);
  });
});

describe("joinIdentifierWords", () => {
  const words = ["tax", "automation", "document"];

  it.each([
    ["snake", "tax_automation_document"],
    ["camel", "taxAutomationDocument"],
    ["pascal", "TaxAutomationDocument"],
    ["screamingSnake", "TAX_AUTOMATION_DOCUMENT"],
  ] as const)("%s → %s", (casing, rendered) => {
    expect(joinIdentifierWords(words, casing)).toBe(rendered);
  });

  it("renders no words as an empty string", () => {
    expect(joinIdentifierWords([], "camel")).toBe("");
  });
});

describe("renderIdentifier", () => {
  it.each([
    ["snake", "tax_automation_document"],
    ["camel", "taxAutomationDocument"],
    ["pascal", "TaxAutomationDocument"],
    ["screamingSnake", "TAX_AUTOMATION_DOCUMENT"],
  ] as const)("renders the last namespace segment in %s casing", (casing, rendered) => {
    expect(renderIdentifier("Foo::TaxAutomationDocument", casing)).toBe(rendered);
  });

  it("takes the last segment of a dotted name and drops a leading ::", () => {
    expect(renderIdentifier("models.TaxDocument", "snake")).toBe("tax_document");
    expect(renderIdentifier("::System", "snake")).toBe("system");
    expect(renderIdentifier("A::B", "camel")).toBe("b");
  });

  it("ignores generic arguments left on the type name", () => {
    expect(renderIdentifier("Repository<Job>", "camel")).toBe("repository");
  });
});

describe("renderIdentifierPlural", () => {
  it.each([
    ["snake", "tax_automation_documents"],
    ["camel", "taxAutomationDocuments"],
    ["pascal", "TaxAutomationDocuments"],
    ["screamingSnake", "TAX_AUTOMATION_DOCUMENTS"],
  ] as const)("pluralizes the last word in %s casing", (casing, rendered) => {
    expect(renderIdentifierPlural("Foo::TaxAutomationDocument", casing)).toBe(rendered);
  });
});

describe("pluralizeIdentifierWord / singularizeIdentifierWord", () => {
  it.each([
    ["document", "documents"],
    ["box", "boxes"],
    ["match", "matches"],
    ["wish", "wishes"],
    ["address", "addresses"],
    ["buzz", "buzzes"],
    ["entry", "entries"],
    ["day", "days"],
  ])("pluralizes %s → %s", (singular, plural) => {
    expect(pluralizeIdentifierWord(singular)).toBe(plural);
  });

  it.each([
    ["documents", "document"],
    ["automations", "automation"],
    ["boxes", "box"],
    ["matches", "match"],
    ["wishes", "wish"],
    ["addresses", "address"],
    ["statuses", "status"],
    ["cases", "case"],
    ["entries", "entry"],
    ["days", "day"],
  ])("singularizes %s → %s", (plural, singular) => {
    expect(singularizeIdentifierWord(plural)).toBe(singular);
  });

  it.each(["status", "process", "analysis", "is", "data"])("leaves the non-plural %s alone", (word) => {
    expect(singularizeIdentifierWord(word)).toBe(word);
  });
});

describe("detectIdentifierCasing", () => {
  it.each([
    ["tax_automation_document", "snake"],
    ["taxAutomationDocument", "camel"],
    ["TaxAutomationDocument", "pascal"],
    ["TAX_AUTOMATION_DOCUMENT", "screamingSnake"],
    ["@tax_document", "snake"],
    ["find_document!", "snake"],
    ["MAX", "screamingSnake"],
    ["T", "pascal"],
  ] as const)("%s → %s", (name, casing) => {
    expect(detectIdentifierCasing(name)).toBe(casing);
  });

  it("is indeterminate for a single lowercase word (fits snake and camel alike)", () => {
    expect(detectIdentifierCasing("row")).toBeUndefined();
  });

  it("is indeterminate for a mixed style", () => {
    expect(detectIdentifierCasing("tax_AutomationDocument")).toBeUndefined();
    expect(detectIdentifierCasing("")).toBeUndefined();
  });
});
