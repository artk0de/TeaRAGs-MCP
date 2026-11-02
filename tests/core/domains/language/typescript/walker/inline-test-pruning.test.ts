/**
 * Vitest in-source tests stay out of the codegraph (plan 2026-11-02 Task 5):
 * nothing the TypeScript walker extracts may originate inside an
 * `if (import.meta.vitest)` block, while production extraction in the same file
 * stays exactly what it was.
 */
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { walkedExtractionOf, type WalkedTreeForm } from "../../__helpers__/walked-extraction.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";

const extract = (src: string, form: WalkedTreeForm) =>
  walkedExtractionOf(new TypeScriptLanguage(), TsLang.typescript, {
    src,
    relPath: "src/add.ts",
    languageId: "typescript",
    form,
  });

const MIXED = [
  'import { helper } from "./helper";',
  "",
  "export function add(a: number, b: number): number {",
  "  return helper(a) + b;",
  "}",
  "",
  "if (import.meta.vitest) {",
  "  const { it, expect } = import.meta.vitest;",
  "  class Probe extends Fixture {}",
  "  function sumUnderTest(probe: Probe): number {",
  "    return add(1, 2);",
  "  }",
  '  it("adds", () => {',
  "    expect(add(1, 2)).toBe(3);",
  "  });",
  "}",
  "",
].join("\n");

describe.each<WalkedTreeForm>(["native", "materialized"])(
  "TypeScript walker prunes in-source tests (%s tree)",
  (form) => {
    it("emits no chunk, call, binding or declaration from inside the import.meta.vitest block", () => {
      const serialized = JSON.stringify(extract(MIXED, form));
      for (const fromTests of ["sumUnderTest", "Probe", "Fixture", "add(1, 2)", "expect", "adds"]) {
        expect(serialized).not.toContain(fromTests);
      }
    });

    it("keeps the production import and call of the same file", () => {
      const extraction = extract(MIXED, form);
      expect(extraction.imports.map((entry) => entry.importText)).toEqual(["./helper"]);
      expect(extraction.chunks.map((chunk) => chunk.symbolId)).toEqual(["add"]);
      expect(extraction.chunks[0].calls.map((call) => call.callText)).toEqual(["helper(a)"]);
    });
  },
);
