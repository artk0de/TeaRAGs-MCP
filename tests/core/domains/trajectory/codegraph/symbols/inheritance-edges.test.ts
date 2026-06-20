import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { normalizeInheritanceEdges } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";

// Minimal resolver: a fixed set of in-project fq names resolve to their own id.
const IN_PROJECT = new Set(["Animal", "Pet", "Dog", "Comparable", "Logging", "User"]);
const resolve = (fq: string): string | null => (IN_PROJECT.has(fq) ? fq : null);

describe("normalizeInheritanceEdges", () => {
  it("resolves ancestors from the unified inheritanceEdges field", () => {
    const ex = {
      relPath: "dog.ts",
      inheritanceEdges: [
        { source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 },
        { source: "Dog", ancestor: "Pet", kind: "implements", ordinal: 0 },
      ],
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows).toContainEqual({
      sourceFqName: "Dog",
      sourceSymbolId: "Dog",
      ancestorFqName: "Animal",
      ancestorSymbolId: "Animal",
      kind: "super",
      ordinal: 0,
    });
  });

  it("external ancestor resolves to null symbol id but keeps fq name", () => {
    const ex = {
      relPath: "m.rb",
      inheritanceEdges: [{ source: "User", ancestor: "ActiveRecord::Base", kind: "super", ordinal: 0 }],
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows[0]).toMatchObject({
      ancestorFqName: "ActiveRecord::Base",
      ancestorSymbolId: null,
      sourceSymbolId: "User",
    });
  });

  it("lifts legacy classExtends / classAncestors / classPrependedAncestors Records", () => {
    const ex = {
      relPath: "x.rb",
      classExtends: { Dog: "Animal" },
      classAncestors: { Dog: ["Comparable"] },
      classPrependedAncestors: { Dog: ["Logging"] },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    const byKind = rows.reduce<Record<string, string[]>>((m, r) => {
      (m[r.kind] ??= []).push(r.ancestorFqName);
      return m;
    }, {});
    expect(byKind.super).toEqual(["Animal"]);
    expect(byKind.include).toEqual(["Comparable"]);
    expect(byKind.prepend).toEqual(["Logging"]);
  });

  it("inheritanceEdges field wins over legacy when both present (no duplicate)", () => {
    const ex = {
      relPath: "x.ts",
      inheritanceEdges: [{ source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 }],
      classExtends: { Dog: "Animal" },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows.filter((r) => r.sourceFqName === "Dog" && r.kind === "super")).toHaveLength(1);
  });

  it("returns empty when the extraction declares no inheritance", () => {
    expect(normalizeInheritanceEdges({ relPath: "x.ts" } as FileExtraction, resolve)).toEqual([]);
  });

  it("per-source supersede: unified edges suppress ALL legacy Records for that source (bd lz8t)", () => {
    // Ruby parity: the walker now emits precise inheritanceEdges (superclass
    // → super) but ALSO keeps the flat legacy classAncestors for the resolver.
    // Without per-source supersede the legacy lift would re-tag the superclass
    // `Animal` as `include`, producing a spurious second edge with a conflicting
    // kind. The unified field must win for the whole source.
    const ex = {
      relPath: "dog.rb",
      inheritanceEdges: [
        { source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 },
        { source: "Dog", ancestor: "Comparable", kind: "include", ordinal: 0 },
      ],
      classAncestors: { Dog: ["Animal", "Comparable"] },
      classPrependedAncestors: { Dog: ["Logging"] },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    const animal = rows.filter((r) => r.ancestorFqName === "Animal");
    expect(animal).toHaveLength(1);
    expect(animal[0]?.kind).toBe("super");
    // Only the precise include survives — no legacy re-tag, no legacy prepend
    // leak for a source the unified field already owns.
    expect(rows.map((r) => `${r.ancestorFqName}:${r.kind}`).sort()).toEqual(
      ["Animal:super", "Comparable:include"].sort(),
    );
  });

  it("legacy Records still lift for a source ABSENT from inheritanceEdges (per-source, not global)", () => {
    // Supersede is per-source: a different class with only legacy Records must
    // still be lifted even when another source carries unified edges.
    const ex = {
      relPath: "mix.rb",
      inheritanceEdges: [{ source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 }],
      classExtends: { Cat: "Animal" },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows.filter((r) => r.sourceFqName === "Cat")).toHaveLength(1);
    expect(rows.find((r) => r.sourceFqName === "Cat")?.kind).toBe("super");
  });
});
