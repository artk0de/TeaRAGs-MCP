import { describe, expect, it } from "vitest";

import type { FileExtraction, InheritanceEdgeRow } from "../../../../../../src/core/contracts/types/codegraph.js";
import { normalizeInheritanceEdges } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";

// Minimal resolver: a fixed set of in-project fq names resolve to their own id.
const IN_PROJECT = new Set(["Animal", "Pet", "Dog", "Comparable", "Logging", "User"]);
const resolve = (fq: string): string | null => (IN_PROJECT.has(fq) ? fq : null);

/** `source|ancestor|kind` per row, in emission order — the shape bd m1sf0 pins. */
const triples = (rows: readonly InheritanceEdgeRow[]): string[] =>
  rows.map((r) => `${r.sourceFqName}|${r.ancestorFqName}|${r.kind}`);

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

  // WAS "legacy Records still lift for a source ABSENT from inheritanceEdges
  // (per-source, not global)" — that per-source scope is exactly what bd
  // tea-rags-mcp-m1sf0 replaces. Supersede is now per-EXTRACTION: a walker
  // emitting the unified field owns the whole file, so a legacy-only source in
  // the same extraction is no longer lifted. The Python walker keys
  // classAncestors `<relPath>::<fq>` while its inheritanceEdges sources are
  // bare fq, so under per-source scope EVERY Python class produced a junk
  // `include` row per base.
  it("legacy Records do NOT lift for a source absent from inheritanceEdges (per-extraction, bd m1sf0)", () => {
    const ex = {
      relPath: "mix.rb",
      inheritanceEdges: [{ source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 }],
      classExtends: { Cat: "Animal" },
    } as FileExtraction;
    const rows = normalizeInheritanceEdges(ex, resolve);
    expect(rows.filter((r) => r.sourceFqName === "Cat")).toHaveLength(0);
    expect(triples(rows)).toEqual(["Dog|Animal|super"]);
  });

  it("Python shape: file-qualified classAncestors never lifts beside bare-fq unified edges (bd m1sf0)", () => {
    // Faithful `extractFromPythonFile` output for `class C(A, M)` in a.py with
    // `from a import A` / `from m import M`: classAncestors keys are
    // `<relPath>::<fq>` with import-qualified values, classExtends keeps the
    // first base under the BARE name, inheritanceEdges emits every base as
    // `super`. Only the two super rows are real hierarchy.
    const ex = {
      relPath: "a.py",
      classExtends: { C: "A" },
      classAncestors: { "a.py::C": ["a.py::A", "m::M"] },
      inheritanceEdges: [
        { source: "C", ancestor: "A", kind: "super", ordinal: 0 },
        { source: "C", ancestor: "M", kind: "super", ordinal: 1 },
      ],
    } as FileExtraction;
    expect(triples(normalizeInheritanceEdges(ex, resolve))).toEqual(["C|A|super", "C|M|super"]);
  });

  it("Ruby shape stays byte-identical under per-extraction supersede (bd m1sf0)", () => {
    // `attachRubyClassHierarchyChannels` output for
    // `class Dog < Animal; include Comparable; extend Logging; prepend Pet; end`
    // — classAncestors flattens superclass + include + extend, prepend rides its
    // own Record, and inheritanceEdges tags each channel precisely. All sources
    // are bare fq, so per-source and per-extraction supersede agree.
    const ex = {
      relPath: "dog.rb",
      classExtends: { Dog: "Animal" },
      classAncestors: { Dog: ["Animal", "Comparable", "Logging"] },
      classPrependedAncestors: { Dog: ["Pet"] },
      inheritanceEdges: [
        { source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 },
        { source: "Dog", ancestor: "Comparable", kind: "include", ordinal: 0 },
        { source: "Dog", ancestor: "Logging", kind: "extend", ordinal: 0 },
        { source: "Dog", ancestor: "Pet", kind: "prepend", ordinal: 0 },
      ],
    } as FileExtraction;
    expect(triples(normalizeInheritanceEdges(ex, resolve))).toEqual([
      "Dog|Animal|super",
      "Dog|Comparable|include",
      "Dog|Logging|extend",
      "Dog|Pet|prepend",
    ]);
  });

  it("TypeScript shape stays byte-identical under per-extraction supersede (bd m1sf0)", () => {
    // `extractFromTypescriptFile` output for `class Dog extends Animal
    // implements Pet` plus `interface Logging extends Comparable`: classExtends
    // carries only the runtime superclass, inheritanceEdges adds the heritage
    // classExtends deliberately omits. Bare class names on both sides.
    const ex = {
      relPath: "dog.ts",
      classExtends: { Dog: "Animal" },
      inheritanceEdges: [
        { source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 },
        { source: "Dog", ancestor: "Pet", kind: "implements", ordinal: 0 },
        { source: "Logging", ancestor: "Comparable", kind: "implements", ordinal: 0 },
      ],
    } as FileExtraction;
    expect(triples(normalizeInheritanceEdges(ex, resolve))).toEqual([
      "Dog|Animal|super",
      "Dog|Pet|implements",
      "Logging|Comparable|implements",
    ]);
  });

  it("an EMPTY inheritanceEdges array still claims ownership — presence, not content (bd m1sf0)", () => {
    // A walker that emits the field at all has migrated; `[]` means "this file
    // declares no hierarchy", not "fall back to the legacy Records". Today's
    // walkers only assign when non-empty, so this pins the contract, not a
    // production shape.
    const ex = {
      relPath: "empty.py",
      inheritanceEdges: [],
      classAncestors: { "empty.py::C": ["m::M"] },
    } as FileExtraction;
    expect(normalizeInheritanceEdges(ex, resolve)).toEqual([]);
  });

  it("legacy-only extraction (field absent) is still fully lifted (bd m1sf0)", () => {
    // Absence of the field is the un-migrated walker signal — every legacy
    // Record lifts exactly as before.
    const ex = {
      relPath: "legacy.rb",
      classExtends: { Dog: "Animal" },
      classAncestors: { Cat: ["Comparable"] },
      classPrependedAncestors: { Cat: ["Logging"] },
    } as FileExtraction;
    expect(triples(normalizeInheritanceEdges(ex, resolve))).toEqual([
      "Dog|Animal|super",
      "Cat|Comparable|include",
      "Cat|Logging|prepend",
    ]);
  });
});
