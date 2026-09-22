/**
 * Quick/Nimble's DSL vocabulary — the callee reader and the path gate the scope
 * chunker is built on.
 *
 * `.claude/rules/test-spec-chunking.md` prescribes this module as a
 * `filterNode` hook, and Swift does not ship one: Quick's container is a
 * `class_declaration`, already chunkable, so no call node ever needs to enter
 * the chunk set and a filter would have nothing to reject. What remains is the
 * vocabulary, which the scope walk consults on every statement it visits.
 */

import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import {
  getSwiftCallName,
  isQuickSpecFile,
  QUICK_CONTAINER_METHODS,
  QUICK_DSL_METHODS,
  QUICK_EXAMPLE_METHODS,
  QUICK_SETUP_METHODS,
} from "../../../../../../src/core/domains/language/swift/chunking/quick-dsl.js";
import { findFirst, parseSwift } from "./__helpers__/swift-chunking.js";

const QUICK_SPEC = `import Quick

final class InvoiceSpec: QuickSpec {
    override class func spec() {
        describe("Invoice") {
            xcontext("when voided") {
                xit("is skipped") {
                    expect(invoice.total).to(equal(0))
                }
            }
        }

        Quick.describe("qualified") { }
    }
}`;

/** The first `call_expression` whose source text starts with `prefix`. */
function firstCallStartingWith(root: AstNode, prefix: string): AstNode {
  const walk = (node: AstNode): AstNode | null => {
    if (node.type === "call_expression" && node.text.startsWith(prefix)) return node;
    for (const child of node.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(root);
  if (!hit) throw new Error(`No call starting with ${prefix}`);
  return hit;
}

describe("isQuickSpecFile", () => {
  it("accepts SwiftPM test-target paths", () => {
    expect(isQuickSpecFile("Tests/BillingTests/InvoiceSpec.swift")).toBe(true);
  });

  it("accepts Quick's own *Spec.swift suffix outside a Tests directory", () => {
    expect(isQuickSpecFile("Sources/Billing/InvoiceSpec.swift")).toBe(true);
  });

  it("accepts a Specs directory", () => {
    expect(isQuickSpecFile("Specs/InvoiceBehaviour.swift")).toBe(true);
  });

  it("rejects production sources", () => {
    expect(isQuickSpecFile("Sources/Billing/Invoice.swift")).toBe(false);
  });

  it("keeps the gate case-sensitive so Latest.swift stays production", () => {
    expect(isQuickSpecFile("Sources/Billing/Latest.swift")).toBe(false);
  });
});

describe("the three DSL vocabularies", () => {
  it("keeps containers, examples and setup disjoint", () => {
    const all = [...QUICK_CONTAINER_METHODS, ...QUICK_EXAMPLE_METHODS, ...QUICK_SETUP_METHODS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("unions into the vocabulary the scope walk consults", () => {
    expect(QUICK_DSL_METHODS.size).toBe(
      QUICK_CONTAINER_METHODS.size + QUICK_EXAMPLE_METHODS.size + QUICK_SETUP_METHODS.size,
    );
  });

  it.each(["describe", "context", "xdescribe", "fcontext", "sharedExamples"])("treats %s as a container", (name) => {
    expect(QUICK_CONTAINER_METHODS.has(name)).toBe(true);
  });

  it.each(["it", "xit", "fit", "itBehavesLike"])("treats %s as an example", (name) => {
    expect(QUICK_EXAMPLE_METHODS.has(name)).toBe(true);
  });

  it.each(["beforeEach", "afterEach", "beforeSuite", "afterSuite", "justBeforeEach"])("treats %s as setup", (name) => {
    expect(QUICK_SETUP_METHODS.has(name)).toBe(true);
  });

  it("does not claim Nimble's assertion vocabulary", () => {
    expect(QUICK_DSL_METHODS.has("expect")).toBe(false);
  });
});

describe("getSwiftCallName", () => {
  it("reads the callee of a trailing-closure call", async () => {
    const root = await parseSwift(QUICK_SPEC);
    expect(getSwiftCallName(firstCallStartingWith(root, "describe"), QUICK_SPEC)).toBe("describe");
  });

  it("returns null for a qualified callee — the documented v1 limitation", async () => {
    const root = await parseSwift(QUICK_SPEC);
    expect(getSwiftCallName(firstCallStartingWith(root, "Quick.describe"), QUICK_SPEC)).toBeNull();
  });

  it("returns null for anything that is not a call", async () => {
    const root = await parseSwift(QUICK_SPEC);
    expect(getSwiftCallName(findFirst(root, "class_declaration"), QUICK_SPEC)).toBeNull();
  });
});
