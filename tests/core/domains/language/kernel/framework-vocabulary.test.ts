/**
 * The shared framework-vocabulary activation rule (K8, bd tea-rags-mcp-m99j1.1.8):
 * an unconditional vocabulary always loads, a gated one loads iff its activation
 * family intersects the declared dependencies, and no declared set at all (no
 * manifest) keeps every vocabulary on.
 */
import { describe, expect, it } from "vitest";

import {
  FrameworkVocabularyRegistry,
  type FrameworkVocabularyDescriptor,
} from "../../../../../src/core/domains/language/kernel/framework-vocabulary.js";

const core: FrameworkVocabularyDescriptor = { framework: "core" };
const django: FrameworkVocabularyDescriptor = { framework: "django", activatedBy: new Set(["django"]) };
const drf: FrameworkVocabularyDescriptor = {
  framework: "drf",
  activatedBy: new Set(["djangorestframework", "drf-core"]),
};

describe("FrameworkVocabularyRegistry#active", () => {
  const registry = new FrameworkVocabularyRegistry([core, django, drf]);

  it("keeps a vocabulary without activatedBy active for any declared set", () => {
    expect(registry.active(new Set())).toEqual([core]);
    expect(registry.active(new Set(["flask"]))).toEqual([core]);
  });

  it("activates a gated vocabulary only when one of its activators is declared", () => {
    expect(registry.active(new Set(["django"]))).toEqual([core, django]);
    expect(registry.active(new Set(["drf-core", "httpx"]))).toEqual([core, drf]);
  });

  it("matches activators exactly, never by prefix", () => {
    expect(registry.active(new Set(["django-filter"]))).toEqual([core]);
  });

  it("keeps every vocabulary active when nothing is declared at all (no manifest)", () => {
    expect(registry.active(undefined)).toEqual([core, django, drf]);
    expect(registry.active(null)).toEqual([core, django, drf]);
  });

  it("memoises per declared-set identity", () => {
    const declared = new Set(["django"]);
    expect(registry.active(declared)).toBe(registry.active(declared));
    expect(registry.active(new Set(["django"]))).not.toBe(registry.active(declared));
  });
});
