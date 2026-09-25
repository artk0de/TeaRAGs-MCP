/**
 * Go type-abstractness census (bd tea-rags-mcp-r8hme.8). An interface type
 * declaring a method is abstract; a struct type is concrete. A constraint
 * interface (a type set, no method), an empty interface and a defined type over
 * another type count as neither.
 */
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new GoLanguage(), GoLang, src, "pkg/a.go", "go");

describe("Go walker — type-abstractness census", () => {
  it("reads method-declaring interfaces as abstract and structs as concrete", () => {
    const src = [
      "package pkg",
      "type Store interface { Get() int }",
      "type Number interface { ~int | ~float64 }",
      "type Any interface{}",
      "type Engine struct { store Store }",
      "type ID int",
      "type (",
      "\tReader interface { Read() error }",
      "\tRow struct{}",
      ")",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 2, concreteTypeCount: 2 });
  });
});
