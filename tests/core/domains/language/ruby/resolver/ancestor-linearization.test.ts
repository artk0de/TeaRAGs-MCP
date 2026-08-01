import { describe, expect, it } from "vitest";

import {
  linearizeAncestors,
  type RubyAncestorHierarchy,
} from "../../../../../../src/core/domains/language/ruby/resolver/ancestor-linearization.js";

// bd tea-rags-mcp-uuux9 — the ORDERING substrate every MRO-sensitive consumer
// reads. Each case below is a Ruby program whose `Class.ancestors` is the
// expected array, so the pins are checkable against a real interpreter rather
// than against this implementation's own habits.

describe("linearizeAncestors — Ruby MRO linearization (uuux9)", () => {
  const h = (over: RubyAncestorHierarchy): RubyAncestorHierarchy => over;

  it("is the class alone when nothing about its hierarchy is known", () => {
    expect(linearizeAncestors("C", h({}))).toEqual(["C"]);
  });

  it("expands the superclass chain transitively", () => {
    // class B < A; class C < B  →  C.ancestors == [C, B, A]
    const hierarchy = h({
      classAncestors: { C: ["B"], B: ["A"] },
      classExtends: { C: "B", B: "A" },
    });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["C", "B", "A"]);
  });

  it("puts INCLUDED modules before the superclass", () => {
    // class Sub < Base; include M  →  Sub.ancestors == [Sub, M, Base]
    // The walker stores classAncestors as [superclass, ...includes], so this is
    // exactly the order the raw list gets wrong.
    const hierarchy = h({
      classAncestors: { Sub: ["Base", "M"] },
      classExtends: { Sub: "Base" },
    });
    expect(linearizeAncestors("Sub", hierarchy)).toEqual(["Sub", "M", "Base"]);
  });

  it("ranks a LATER include nearer than an earlier one", () => {
    // class C; include A; include B  →  C.ancestors == [C, B, A]
    expect(linearizeAncestors("C", h({ classAncestors: { C: ["A", "B"] } }))).toEqual(["C", "B", "A"]);
  });

  it("puts PREPENDED modules before the class itself, last prepend nearest", () => {
    // class C; prepend A; prepend B  →  C.ancestors == [B, A, C]
    expect(linearizeAncestors("C", h({ classPrependedAncestors: { C: ["A", "B"] } }))).toEqual(["B", "A", "C"]);
  });

  it("expands a prepended module's OWN ancestry ahead of the class", () => {
    // module P; include Q; end / class C; prepend P  →  [P, Q, C]
    const hierarchy = h({
      classPrependedAncestors: { C: ["P"] },
      classAncestors: { P: ["Q"] },
    });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["P", "Q", "C"]);
  });

  it("expands a nested module chain depth-first", () => {
    // module N; include O / module M; include N / class C; include M  →  [C, M, N, O]
    const hierarchy = h({ classAncestors: { C: ["M"], M: ["N"], N: ["O"] } });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["C", "M", "N", "O"]);
  });

  it("treats a re-include of an already-reachable module as a no-op (diamond)", () => {
    // module B; include A / class C; include B; include A  →  [C, B, A]
    // Ruby does NOT hoist A above B: it is already in the chain, so the second
    // `include` inserts nothing.
    const hierarchy = h({ classAncestors: { C: ["B", "A"], B: ["A"] } });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["C", "B", "A"]);
  });

  it("keeps that no-op stable when the include order is reversed", () => {
    // module B; include A / class C; include A; include B  →  [C, B, A]
    const hierarchy = h({ classAncestors: { C: ["A", "B"], B: ["A"] } });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["C", "B", "A"]);
  });

  it("does not hoist a module the SUPERCLASS already carries", () => {
    // class Base; include M / class C < Base; include M  →  [C, Base, M]
    // M is reachable through Base, so C's own `include M` inserts nothing and M
    // must stay BEHIND Base rather than jumping ahead of it.
    const hierarchy = h({
      classAncestors: { C: ["Base", "M"], Base: ["M"] },
      classExtends: { C: "Base" },
    });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["C", "Base", "M"]);
  });

  it("does not re-insert a module that is both included and prepended", () => {
    // class C; include M; prepend M  →  [C, M] (the prepend is a no-op)
    const hierarchy = h({
      classAncestors: { C: ["M"] },
      classPrependedAncestors: { C: ["M"] },
    });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["C", "M"]);
  });

  it("orders prepend, class, include and superclass in one hierarchy", () => {
    // class C < Base; prepend P; include M  →  [P, C, M, Base]
    const hierarchy = h({
      classAncestors: { C: ["Base", "M"] },
      classPrependedAncestors: { C: ["P"] },
      classExtends: { C: "Base" },
    });
    expect(linearizeAncestors("C", hierarchy)).toEqual(["P", "C", "M", "Base"]);
  });

  it("terminates on a superclass cycle in the extracted data", () => {
    const hierarchy = h({
      classAncestors: { A: ["B"], B: ["A"] },
      classExtends: { A: "B", B: "A" },
    });
    expect(linearizeAncestors("A", hierarchy)).toEqual(["A", "B"]);
  });

  it("terminates on a self-referential ancestor entry", () => {
    expect(linearizeAncestors("C", h({ classAncestors: { C: ["C"] } }))).toEqual(["C"]);
  });

  it("still orders includes nearest-last-first when classExtends is absent", () => {
    // Without classExtends the walker's leading superclass entry is indistinguishable
    // from an include — reverse declaration order still sinks it to the end.
    expect(linearizeAncestors("C", h({ classAncestors: { C: ["Base", "M", "N"] } }))).toEqual([
      "C",
      "N",
      "M",
      "Base",
    ]);
  });
});
