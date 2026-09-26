/**
 * bd tea-rags-mcp-39xca.14 — the codegraph provider learns which languages
 * derive structural conformance from the languages themselves, and the
 * production factory offers it exactly for the structurally typed ones.
 */
import { describe, expect, it } from "vitest";

import type { LanguageFactoryDescriptor } from "../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { collectStructuralConformanceDerivers } from "../../../../../src/core/domains/trajectory/codegraph/exclusion.js";

describe("collectStructuralConformanceDerivers", () => {
  it("is empty without a factory", () => {
    expect(collectStructuralConformanceDerivers(undefined).size).toBe(0);
  });

  it("keeps only the languages offering a deriver", () => {
    const derive = () => [];
    const factory = {
      supported: () => ["typescript", "ruby"],
      create: (lang: string) => (lang === "typescript" ? { structuralConformance: derive } : {}),
    } as unknown as LanguageFactoryDescriptor;

    expect([...collectStructuralConformanceDerivers(factory)]).toEqual([["typescript", derive]]);
  });

  it("finds TypeScript and Python in the production factory, and not Ruby", () => {
    const languages = [...collectStructuralConformanceDerivers(new LanguageFactory()).keys()];

    expect(languages).toContain("typescript");
    expect(languages).toContain("python");
    expect(languages).not.toContain("ruby");
  });
});
