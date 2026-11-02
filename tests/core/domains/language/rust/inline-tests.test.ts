import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { AstNode } from "../../../../../src/core/contracts/types/ast.js";
import {
  fileIsInlineTestOnly,
  isInlineTestNode,
  isRustTestFunctionNode,
  rustCfgIsTestOnly,
} from "../../../../../src/core/domains/language/rust/inline-tests.js";

const ITEM_TYPES = new Set(["function_item", "mod_item", "struct_item"]);

function parseRoot(code: string, materialized: boolean): AstNode {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const native = parser.parse(code).rootNode;
  return materialized ? materializeTree(native, code) : native;
}

/** The first item of the root — the node every table row asserts on. */
function firstItem(code: string, materialized = false): AstNode {
  const item = parseRoot(code, materialized).namedChildren.find((child) => ITEM_TYPES.has(child.type));
  if (!item) throw new Error(`no item in ${JSON.stringify(code)}`);
  return item;
}

const TABLE: readonly (readonly [string, boolean])[] = [
  ["#[test]\nfn a() {}", true],
  ["#[test] fn a() {}", true],
  ['#[tokio::test(flavor = "multi_thread")]\nasync fn a() {}', true],
  ["#[test] // flaky\nfn a() {}", true],
  ['#[test]\n#[should_panic(\n  expected = "x"\n)]\nfn a() {}', true],
  ["#[wasm_bindgen_test]\nfn a() {}", true],
  ["#[bench]\nfn a(b: &mut Bencher) {}", true],
  ["#[quickcheck]\nfn a(x: u8) -> bool { true }", true],
  ["#[proptest]\nfn a(x: u8) {}", true],
  ['#[test_case(1 ; "one")]\n#[test_case(2 ; "two")]\nfn a(x: u8) {}', true],
  ["#[rstest]\nfn a() {}", true],
  ["#[cfg(test)]\nfn helper() {}", true],
  ["fn a() {}", false],
  ["#[cfg(test)]\nmod tests { fn h() {} }", true],
  ["#[cfg(test)] mod tests { fn h() {} }", true],
  ['#[cfg(all(test, feature = "x"))]\nmod tests { fn h() {} }', true],
  ['#[cfg(any(test, feature = "x"))]\nmod testing { fn h() {} }', false],
  ["#[cfg(not(test))]\nmod real { fn h() {} }", false],
  ["#[cfg(\n  test\n)]\nmod tests { fn h() {} }", true],
  ["mod tests {\n  #![cfg(test)]\n  fn h() {}\n}", true],
  ["mod t {\n  #[test]\n  fn a() {}\n}", false],
  ["#[cfg(test)]\nmod tests;", true],
  ["#[derive(Debug)]\nstruct S;", false],
];

describe("isInlineTestNode (Rust)", () => {
  for (const [source, expected] of TABLE) {
    it(`${JSON.stringify(source)} → ${expected}`, () => {
      expect(isInlineTestNode(firstItem(source), source)).toBe(expected);
    });
  }

  it("answers identically on a materialized tree", () => {
    for (const [source, expected] of TABLE) {
      expect(isInlineTestNode(firstItem(source, true), source), source).toBe(expected);
    }
  });
});

describe("isRustTestFunctionNode", () => {
  it("is true for a test-family function and false for a cfg(test) helper or a module", () => {
    const test = "#[tokio::test]\nasync fn a() {}";
    const helper = "#[cfg(test)]\nfn helper() {}";
    const module = "#[cfg(test)]\nmod tests { fn h() {} }";
    expect(isRustTestFunctionNode(firstItem(test), test)).toBe(true);
    expect(isRustTestFunctionNode(firstItem(helper), helper)).toBe(false);
    expect(isRustTestFunctionNode(firstItem(module), module)).toBe(false);
  });
});

describe("rustCfgIsTestOnly", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["test", true],
    ["all(test, unix)", true],
    ["any(test, unix)", false],
    ["not(test)", false],
    ["unix", false],
    ["all(not(test), test)", true],
  ];
  for (const [predicate, expected] of cases) {
    it(`${predicate} → ${expected}`, () => {
      expect(rustCfgIsTestOnly(predicate)).toBe(expected);
    });
  }

  it("treats key-value predicates as unknown and unparseable text as not test-only", () => {
    expect(rustCfgIsTestOnly('all(test, feature = "x")')).toBe(true);
    expect(rustCfgIsTestOnly('feature = "x"')).toBe(false);
    expect(rustCfgIsTestOnly("not(test, unix)")).toBe(false);
    for (const malformed of ["", "test)", "all(test", "all(test unix)", "test ; x", "feature = x", "(test)"]) {
      expect(rustCfgIsTestOnly(malformed), malformed).toBe(false);
    }
  });
});

describe("fileIsInlineTestOnly", () => {
  it("is true for a file root carrying #![cfg(test)]", () => {
    const code = "#![cfg(test)]\nfn a() {}";
    expect(fileIsInlineTestOnly(parseRoot(code, false), code)).toBe(true);
    expect(fileIsInlineTestOnly(parseRoot(code, true), code)).toBe(true);
  });

  it("is false for a plain file", () => {
    const code = "fn a() {}";
    expect(fileIsInlineTestOnly(parseRoot(code, false), code)).toBe(false);
  });
});
