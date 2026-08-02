/**
 * Per-language signal floors — spec
 * docs/superpowers/specs/2026-08-02-module-mass-signals-design.md.
 *
 * Floors are language-specific by nature: RuboCop caps a Ruby class at 100
 * lines while pylint lets a Python module run to 1000. The factory aggregates
 * them the same lightweight way it aggregates capabilities — one const import
 * per language, no provider constructed, no grammar loaded.
 */

import { describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../src/core/domains/language/index.js";

const MASS_SIGNALS = ["moduleLines", "moduleMethodCount", "memberCount"];

describe("LanguageFactory.signalFloors", () => {
  const factory = new LanguageFactory();
  const floors = factory.signalFloors();

  it("covers every supported language, so adding one forces a floors decision", () => {
    for (const lang of factory.supported()) {
      expect(floors.has(lang), `language "${lang}" declares no signal floors`).toBe(true);
    }
    expect(floors.size).toBe(factory.supported().length);
  });

  it("declares all three mass signals for every code language", () => {
    for (const [lang, langFloors] of floors) {
      // markdown is doc-only — it declares an empty object deliberately.
      if (lang === "markdown") continue;
      for (const signal of MASS_SIGNALS) {
        expect(Object.keys(langFloors), `${lang} is missing floors for ${signal}`).toContain(signal);
      }
    }
  });

  it("leaves markdown empty rather than absent — an explicit no-floors decision", () => {
    expect(floors.get("markdown")).toEqual({});
  });

  it("keeps every signal's floors monotone, so raised thresholds cannot cross", () => {
    for (const [lang, langFloors] of floors) {
      for (const [signal, labelFloors] of Object.entries(langFloors)) {
        const values = Object.values(labelFloors);
        const sorted = [...values].sort((a, b) => a - b);
        expect(values, `${lang}.${signal} declares non-monotone floors`).toEqual(sorted);
      }
    }
  });

  it("anchors TypeScript on ESLint max-lines and PMD TooManyMethods", () => {
    const ts = floors.get("typescript")!;
    expect(ts.moduleLines).toEqual({ large: 300, "god-module": 600 });
    expect(ts.memberCount).toEqual({ large: 10, "god-module": 20 });
  });

  it("gives Ruby the tighter RuboCop ClassLength budget", () => {
    expect(floors.get("ruby")!.moduleLines).toEqual({ large: 100, "god-module": 250 });
  });

  it("gives Python the roomier pylint max-module-lines budget", () => {
    expect(floors.get("python")!.moduleLines).toEqual({ large: 500, "god-module": 1000 });
  });

  it("names only labels the payload descriptors actually declare", () => {
    const declared = new Set(["small", "large", "god-module", "typical", "busy"]);
    for (const [lang, langFloors] of floors) {
      for (const [signal, labelFloors] of Object.entries(langFloors)) {
        for (const label of Object.keys(labelFloors)) {
          expect(declared, `${lang}.${signal} floors an unknown label "${label}"`).toContain(label);
        }
      }
    }
  });
});
