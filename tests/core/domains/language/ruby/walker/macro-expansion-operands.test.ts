/**
 * Unit tests for `extractOperands` — the parameterised argument-extraction
 * engine introduced in Task A of the Ruby DSL grammar consolidation (pg5ya).
 *
 * Each test builds a minimal synthetic `AstNode` representing the `arguments`
 * node of a macro call (following the `fakeNode` pattern established in
 * `macro-expansion.test.ts`) and asserts that `extractOperands` returns the
 * expected base names for the given `DslOperandsShape`.
 */
import { describe, expect, it } from "vitest";

import type { DslOperandsShape } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";
import { extractOperands } from "../../../../../../src/core/domains/language/ruby/walker/macro-expansion.js";

/** Build a minimal fake AstNode that satisfies the AstNode interface. */
function fakeNode(type: string, text: string, namedChildren: ReturnType<typeof fakeNode>[] = []) {
  return {
    type,
    text,
    children: namedChildren as unknown as readonly ReturnType<typeof fakeNode>[],
    namedChildren: namedChildren as unknown as readonly ReturnType<typeof fakeNode>[],
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    parent: null,
    previousNamedSibling: null,
    childForFieldName: (_field: string) => null,
    child: (_i: number) => null,
    namedChild: (_i: number) => null,
  };
}

/** Build a simple_symbol node like `:foo`. */
const sym = (name: string) => fakeNode("simple_symbol", `:${name}`);
/** Build a non-symbol node (pair, lambda, identifier, …). */
const pair = (text = "to: :other") => fakeNode("pair", text);
const ident = (name: string) => fakeNode("identifier", name);
/** Build a string node with a string_content child. */
const str = (value: string) => fakeNode("string", `"${value}"`, [fakeNode("string_content", value)]);
/** Build an args node from its named children. */
const args = (...children: ReturnType<typeof fakeNode>[]) => fakeNode("argument_list", "", children);

// ---------------------------------------------------------------------------
// null guard
// ---------------------------------------------------------------------------

describe("extractOperands — null args", () => {
  it("always returns [] for null args, regardless of shape", () => {
    const shapes: DslOperandsShape[] = [
      "literal-name",
      "first-symbol",
      "skip-first",
      "leading-symbols",
      { kind: "leading-symbols", stopAtKwarg: true },
    ];
    for (const shape of shapes) {
      expect(extractOperands(null, shape)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 'literal-name'  (define_method)
// ---------------------------------------------------------------------------

describe("extractOperands — 'literal-name'", () => {
  it("simple_symbol first arg → stripped name", () => {
    expect(extractOperands(args(sym("foo")), "literal-name")).toEqual(["foo"]);
  });

  it("string literal first arg → inner text", () => {
    expect(extractOperands(args(str("bar")), "literal-name")).toEqual(["bar"]);
  });

  it("dynamic identifier first arg → [] (name not statically known)", () => {
    expect(extractOperands(args(ident("verb")), "literal-name")).toEqual([]);
  });

  it("empty args → []", () => {
    expect(extractOperands(args(), "literal-name")).toEqual([]);
  });

  it("string with empty value → []", () => {
    // literalNameFromArg returns null for empty string text
    expect(extractOperands(args(str("")), "literal-name")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 'first-symbol'  (alias_method, scope, attribute)
// ---------------------------------------------------------------------------

describe("extractOperands — 'first-symbol'", () => {
  it("first namedChild is simple_symbol → one name", () => {
    expect(extractOperands(args(sym("new_name"), sym("old_name")), "first-symbol")).toEqual(["new_name"]);
  });

  it("first namedChild is NOT simple_symbol → []", () => {
    expect(extractOperands(args(ident("foo"), sym("old_name")), "first-symbol")).toEqual([]);
  });

  it("first is simple_symbol, rest includes non-symbols → only first", () => {
    // scope :active, -> {} — lambda is not a symbol, only :active matters
    expect(extractOperands(args(sym("active"), fakeNode("lambda", "-> {}")), "first-symbol")).toEqual(["active"]);
  });

  it("first is simple_symbol, rest includes more symbols → only first", () => {
    // attribute :name, :string — only :name is the attribute name
    expect(extractOperands(args(sym("name"), sym("string")), "first-symbol")).toEqual(["name"]);
  });

  it("empty args → []", () => {
    expect(extractOperands(args(), "first-symbol")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 'skip-first'  (store_accessor)
// ---------------------------------------------------------------------------

describe("extractOperands — 'skip-first'", () => {
  it("skips the first symbol (store column) and returns the rest", () => {
    expect(extractOperands(args(sym("settings"), sym("color"), sym("theme")), "skip-first")).toEqual([
      "color",
      "theme",
    ]);
  });

  it("only the store column present → []", () => {
    expect(extractOperands(args(sym("settings")), "skip-first")).toEqual([]);
  });

  it("non-symbol arg among accessors is skipped (CONTINUE behaviour)", () => {
    // store_accessor :store, :a, "ignored", :b — string is skipped, :a and :b collected, first dropped
    expect(extractOperands(args(sym("store"), sym("a"), str("extra"), sym("b")), "skip-first")).toEqual(["a", "b"]);
  });

  it("empty args → []", () => {
    expect(extractOperands(args(), "skip-first")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 'leading-symbols'  (generic: attr_*, associations, validations, …)
// ---------------------------------------------------------------------------

describe("extractOperands — 'leading-symbols'", () => {
  it("all simple_symbol args → all names", () => {
    expect(extractOperands(args(sym("a"), sym("b"), sym("c")), "leading-symbols")).toEqual(["a", "b", "c"]);
  });

  it("non-symbol in the middle is SKIPPED (continue), symbols on both sides collected", () => {
    // The generic path does not break on non-symbols — it skips and continues.
    expect(extractOperands(args(sym("a"), pair(), sym("b")), "leading-symbols")).toEqual(["a", "b"]);
  });

  it("non-symbol at the start is skipped, trailing symbols collected", () => {
    expect(extractOperands(args(ident("extra"), sym("a"), sym("b")), "leading-symbols")).toEqual(["a", "b"]);
  });

  it("no simple_symbol args → []", () => {
    expect(extractOperands(args(pair()), "leading-symbols")).toEqual([]);
  });

  it("empty args → []", () => {
    expect(extractOperands(args(), "leading-symbols")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// { kind: 'leading-symbols', stopAtKwarg: true }  (delegate)
// ---------------------------------------------------------------------------

describe("extractOperands — leading-symbols with stopAtKwarg (delegate)", () => {
  const STOP: DslOperandsShape = { kind: "leading-symbols", stopAtKwarg: true };

  it("leading symbols collected, BREAKS at the first non-symbol (kwarg pair)", () => {
    // delegate :a, :b, to: :other — 'to: :other' is a pair node, not a symbol
    expect(extractOperands(args(sym("a"), sym("b"), pair("to: :other")), STOP)).toEqual(["a", "b"]);
  });

  it("no trailing symbols after kwarg pair are collected", () => {
    // If somehow a symbol follows the pair it must NOT be collected
    expect(extractOperands(args(sym("a"), pair("to: :x"), sym("stray")), STOP)).toEqual(["a"]);
  });

  it("non-symbol as first arg → BREAKS immediately → []", () => {
    expect(extractOperands(args(pair("to: :other"), sym("a")), STOP)).toEqual([]);
  });

  it("only symbols, no kwarg → collects all (no break triggered)", () => {
    expect(extractOperands(args(sym("a"), sym("b")), STOP)).toEqual(["a", "b"]);
  });

  it("empty args → []", () => {
    expect(extractOperands(args(), STOP)).toEqual([]);
  });

  it("stopAtKwarg=true BREAKS; plain 'leading-symbols' CONTINUES past same pair", () => {
    // Same args node — behaviour diverges only at the non-symbol node
    const argNode = args(sym("a"), pair("to: :x"), sym("b"));
    expect(extractOperands(argNode, STOP)).toEqual(["a"]);
    expect(extractOperands(argNode, "leading-symbols")).toEqual(["a", "b"]);
  });
});
