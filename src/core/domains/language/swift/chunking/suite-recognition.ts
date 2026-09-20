/**
 * Swift test-suite recognition — which Swift declarations are a test harness,
 * and which of their members are test CASES rather than fixtures.
 *
 * Two frameworks, one shape. XCTest declares cases as `test`-prefixed
 * zero-argument instance methods on an `XCTestCase` subclass; swift-testing
 * declares them as `@Test` functions, optionally inside an `@Suite` type. Both
 * are ordinary member declarations, so the chunker engine already emits them
 * with the right range and the right symbolId (`LedgerTests#testAddIncreasesTotal`,
 * `InvoiceTests.WhenOverdue#addsPenalty` through the kernel's
 * `scopeContainerTypes`). The only thing missing is the LABEL, so this module
 * produces exactly that and writes it to `ctx.methodChunkTypes`.
 *
 * Why there is no scope chunker here. `.claude/rules/test-spec-chunking.md`
 * prescribes a filter + scope-tree pair for test-spec DSLs — describe/context
 * CALL expressions whose nesting the generic chunker cannot see and whose
 * parent setup has to be spliced into each leaf. Neither condition holds:
 *
 *   - XCTest has no nesting at all. `setUp` applies to the whole class and
 *     already sits in the same container as the cases it prepares.
 *   - swift-testing nests through TYPES (`@Suite struct Outer { @Suite struct
 *     Inner { … } }`), and a nested type is a `class_declaration` the kernel
 *     already treats as a scope container — verified: the engine composes
 *     `InvoiceTests.WhenOverdue#addsPenalty` today, before this module existed.
 *
 * Claiming the container to re-emit those chunks would move symbolId
 * composition into the hook (against `.claude/rules/symbolid-convention.md`)
 * and forfeit overload disambiguation, intermediate-scope collection and the
 * oversized-child split the engine performs. Quick/Nimble IS a trailing-closure
 * DSL and does need the canonical scope chunker — it is deliberately out of
 * scope here and gets its own vertical.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, ChunkType, HookContext } from "../../../../contracts/types/chunker.js";
import { classifyMethod } from "../../../../infra/symbolid/index.js";

/** Which test framework a Swift type belongs to. */
export type SwiftSuiteKind = "xctest" | "swift-testing";

/** `FooTests.swift` / `FooTest.swift` — the conventional XCTest file suffixes. */
const TEST_FILE_SUFFIX = /Tests?\.swift$/;

/** SwiftPM puts every test target under a top-level `Tests/` directory. */
const TEST_DIRECTORY = /(^|[/\\])Tests[/\\]/;

/** The base class every XCTest suite ultimately descends from. */
const XCTEST_BASE_CLASS = "XCTestCase";

/** swift-testing's two attributes: the case marker and the (optional) type marker. */
const SWIFT_TESTING_CASE_ATTRIBUTE = "Test";
const SWIFT_TESTING_SUITE_ATTRIBUTE = "Suite";

/** XCTest discovers cases by selector prefix. */
const XCTEST_CASE_PREFIX = "test";

/**
 * Conventional test-file layout for Swift: the `*Tests.swift` / `*Test.swift`
 * suffixes and SwiftPM's `Tests/` target directory. Case-sensitive on purpose —
 * `Latest.swift` and `Manifest.swift` are production files.
 */
export function isSwiftTestFile(filePath: string): boolean {
  return TEST_FILE_SUFFIX.test(filePath) || TEST_DIRECTORY.test(filePath);
}

/** The first named child of `type`, or null. */
function namedChildOfType(node: AstNode, type: string): AstNode | null {
  return node.namedChildren.find((c) => c.type === type) ?? null;
}

/**
 * Attribute names carried by a declaration's `modifiers` wrapper. `@Test("named
 * case", .tags(.fast))` parses as `attribute > user_type` plus its arguments,
 * so the name is the `user_type` text.
 */
function attributeNames(node: AstNode): string[] {
  const modifiers = namedChildOfType(node, "modifiers");
  if (!modifiers) return [];
  return modifiers.namedChildren
    .filter((c) => c.type === "attribute")
    .map((attr) => namedChildOfType(attr, "user_type")?.text)
    .filter((name): name is string => name !== undefined);
}

function hasAttribute(node: AstNode, name: string): boolean {
  return attributeNames(node).includes(name);
}

/**
 * The declaration keyword tree-sitter-swift parses as an ANONYMOUS child —
 * one `class_declaration` node covers `class` / `struct` / `enum` /
 * `extension` / `actor`, so the keyword is the only way to tell them apart.
 */
function declarationKeyword(node: AstNode): string | undefined {
  return node.children.find((c) => !c.isNamed && DECLARATION_KEYWORDS.has(c.type))?.type;
}

const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set(["class", "struct", "enum", "extension", "actor"]);

/**
 * Names in the declaration's inheritance clause. Each `inheritance_specifier`
 * holds one supertype or protocol; the text may be qualified
 * (`XCTest.XCTestCase`), so callers compare the trailing segment.
 */
function inheritanceNames(node: AstNode): string[] {
  return node.namedChildren.filter((c) => c.type === "inheritance_specifier").map((c) => c.text.trim());
}

function inheritsXCTestCase(node: AstNode): boolean {
  return inheritanceNames(node).some((name) => name.split(".").pop() === XCTEST_BASE_CLASS);
}

/** Declared member functions / initializers of a type body, in source order. */
function memberDeclarations(node: AstNode): AstNode[] {
  const body = namedChildOfType(node, "class_body");
  if (!body) return [];
  return body.namedChildren.filter((c) => c.type === "function_declaration" || c.type === "init_declaration");
}

/** A declaration's own name — `function_declaration` carries it in the `name` field. */
function declaredName(node: AstNode): string | undefined {
  return node.childForFieldName("name")?.text ?? namedChildOfType(node, "simple_identifier")?.text;
}

/**
 * XCTest's own discovery rule, not a loose prefix match: the ObjC runtime
 * enumerates zero-argument instance selectors beginning with `test`. A
 * `func testAmount(for invoice: Invoice) -> Decimal` helper and a
 * `class func testSuiteWideInvariant()` are both harness, not cases.
 */
function isXCTestCase(node: AstNode): boolean {
  if (node.type !== "function_declaration") return false;
  if (!declaredName(node)?.startsWith(XCTEST_CASE_PREFIX)) return false;
  if (node.namedChildren.some((c) => c.type === "parameter")) return false;
  return classifyMethod(node) === "instance";
}

/**
 * Which framework — if any — a type declaration belongs to.
 *
 * Structural evidence is tried first and works anywhere, including in a file
 * whose name says nothing: an `XCTestCase` subclass and an `@Suite` / `@Test`
 * declaration are unambiguous. The path gate exists only for the one shape
 * structure cannot see — a class extending a project-local base case
 * (`final class LedgerTests: BaseTestCase`), which is common enough in real
 * Swift projects to be worth catching and is safe to key on the path because a
 * production file never matches `isSwiftTestFile`.
 */
export function detectSwiftSuiteKind(containerNode: AstNode, filePath: string): SwiftSuiteKind | null {
  if (containerNode.type !== "class_declaration") return null;

  if (hasAttribute(containerNode, SWIFT_TESTING_SUITE_ATTRIBUTE)) return "swift-testing";
  if (inheritsXCTestCase(containerNode)) return "xctest";

  const members = memberDeclarations(containerNode);
  if (members.some((m) => hasAttribute(m, SWIFT_TESTING_CASE_ATTRIBUTE))) return "swift-testing";

  // A `class` in a test file whose members follow XCTest's naming rule — the
  // project-local-base-case shape. Restricted to `class` because that is what
  // XCTest requires; a `struct` full of `testFoo()` helpers stays production.
  if (isSwiftTestFile(filePath) && declarationKeyword(containerNode) === "class" && members.some(isXCTestCase)) {
    return "xctest";
  }

  return null;
}

/**
 * Label one member of a recognized suite. Everything that is not a case is
 * `test_setup` — `setUp` / `tearDownWithError`, swift-testing's `init` (which
 * IS its per-case setup mechanism), and plain helpers. `test_setup` is not a
 * demotion: `detectScope` drops it from BOTH the source and the test scope, so
 * a fixture factory living in a test target stops being counted as production
 * code the moment Swift starts labelling anything at all.
 */
export function classifySwiftSuiteMember(memberNode: AstNode, suiteKind: SwiftSuiteKind): ChunkType {
  if (suiteKind === "swift-testing") {
    return hasAttribute(memberNode, SWIFT_TESTING_CASE_ATTRIBUTE) ? "test" : "test_setup";
  }
  return isXCTestCase(memberNode) ? "test" : "test_setup";
}

/**
 * Metadata hook (chain position 2): labels the children of a recognized suite
 * and writes nothing else. It must NOT touch `ctx.bodyChunks` — that would
 * short-circuit the chain before the container-body chunker runs.
 */
export const swiftSuiteClassificationHook: ChunkingHook = {
  name: "swiftSuiteClassification",
  process(ctx: HookContext): void {
    const suiteKind = detectSwiftSuiteKind(ctx.containerNode, ctx.filePath);
    if (!suiteKind) return;
    ctx.validChildren.forEach((child, index) => {
      ctx.methodChunkTypes.set(index, classifySwiftSuiteMember(child, suiteKind));
    });
  },
};
