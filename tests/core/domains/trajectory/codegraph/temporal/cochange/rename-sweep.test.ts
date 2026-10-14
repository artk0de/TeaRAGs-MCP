/**
 * Identifier-rename sweeps (bd tea-rags-mcp-v2525). A commit is a rename sweep
 * when the text it removed becomes the text it added under ONE commit-wide
 * substitution of identifiers — the same mapping in every file. Line counts
 * alone cannot see it (a rename reflows lines), so the verdict reads the diff.
 * A type-only refactor rewrites structure, not names, and stays evidence.
 */

import { describe, expect, it } from "vitest";

import {
  isIdentifierRenameSweep,
  parseCommitDiffs,
  type RenameSweepDiffFile,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

function file(path: string, removed: string[], added: string[]): RenameSweepDiffFile {
  return { path, binary: false, hunks: [{ removed, added }] };
}

describe("isIdentifierRenameSweep", () => {
  it("calls a pure rename sweep mechanical", () => {
    expect(
      isIdentifierRenameSweep([
        file("a.ts", ["import { FooImpl } from './foo.js';"], ["import { Foo } from './foo.js';"]),
        file("b.ts", ["const x = new FooImpl(1);"], ["const x = new Foo(1);"]),
        file("c.ts", ["// builds a FooImpl", "type T = FooImpl;"], ["// builds a Foo", "type T = Foo;"]),
      ]),
    ).toBe(true);
  });

  it("calls a rename plus one real edit not mechanical", () => {
    expect(
      isIdentifierRenameSweep([
        file("a.ts", ["import { FooImpl } from './foo.js';"], ["import { Foo } from './foo.js';"]),
        file("b.ts", ["const x = new FooImpl(1);"], ["const x = new Foo(2);"]),
        file("c.ts", ["type T = FooImpl;"], ["type T = Foo;"]),
      ]),
    ).toBe(false);
  });

  it("calls a type-only refactor not mechanical", () => {
    expect(
      isIdentifierRenameSweep([
        file("a.ts", ["function walk(node: SyntaxNode): void {"], ["function walk(node: AstNode): void {"]),
        file("b.ts", ["const n = node as SyntaxNode;"], ["const n: AstNode = node;"]),
        file("c.ts", ["collect(node);"], ["collect(node as AstNode);"]),
      ]),
    ).toBe(false);
  });

  it("calls a rename that is used unchanged elsewhere in the commit not mechanical", () => {
    // `Foo` is renamed in a.ts and kept in b.ts — no single substitution maps both.
    expect(
      isIdentifierRenameSweep([
        file("a.ts", ["new Foo();"], ["new Bar();"]),
        file("b.ts", ["use(Foo, 1);"], ["use(Foo, 2);"]),
      ]),
    ).toBe(false);
  });

  it("accepts two renames in one commit when one simultaneous substitution explains every file", () => {
    // The chained rename of 5475da96: Impl → Foo while the old Foo → FooDescriptor.
    expect(
      isIdentifierRenameSweep([
        file("a.ts", ["export interface Foo {"], ["export interface FooDescriptor {"]),
        file("b.ts", ["class FooImpl implements Foo {"], ["class Foo implements FooDescriptor {"]),
        file("c.ts", ["const f: Foo = new FooImpl();"], ["const f: FooDescriptor = new Foo();"]),
      ]),
    ).toBe(true);
  });

  it("refuses two names merged into one, and a swap of two names", () => {
    expect(
      isIdentifierRenameSweep([file("a.ts", ["a(Left);"], ["a(Side);"]), file("b.ts", ["b(Right);"], ["b(Side);"])]),
    ).toBe(false);
    expect(isIdentifierRenameSweep([file("a.ts", ["f(a, b);"], ["f(b, a);"])])).toBe(false);
  });

  it("reads through a formatter's reflow: line breaks and trailing commas", () => {
    expect(
      isIdentifierRenameSweep([
        file(
          "a.ts",
          ["import type {", "  A,", "  FooImpl,", "} from './x.js';"],
          ["import type { A, Foo } from './x.js';"],
        ),
        file("b.ts", ["x([FooImpl, 'y'])"], ["x([", "  Foo,", "  'y',", "])"]),
      ]),
    ).toBe(true);
  });

  it("refuses a commit that renames nothing, a binary file, and an added file", () => {
    expect(
      isIdentifierRenameSweep([file("a.ts", ["import {", "  A,", "} from 'x';"], ["import { A } from 'x';"])]),
    ).toBe(false);
    expect(
      isIdentifierRenameSweep([
        file("a.ts", ["new FooImpl();"], ["new Foo();"]),
        { path: "logo.png", binary: true, hunks: [] },
      ]),
    ).toBe(false);
    expect(
      isIdentifierRenameSweep([file("a.ts", ["new FooImpl();"], ["new Foo();"]), file("new.ts", [], ["new Foo();"])]),
    ).toBe(false);
  });

  it("keeps literals out of the substitution", () => {
    expect(isIdentifierRenameSweep([file("a.ts", ["retry(FooImpl, 3);"], ["retry(Foo, 4);"])])).toBe(false);
  });
});

describe("parseCommitDiffs", () => {
  it("splits a no-walk -U0 log into commits, files and hunks", () => {
    const text = [
      "\u0000aaaa",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-new FooImpl();",
      "+new Foo();",
      "@@ -9,2 +9 @@ ctx",
      "-a(",
      "-);",
      "+a();",
      "\\ No newline at end of file",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "\u0000bbbb",
      "",
      "diff --git a/x.ts b/y.ts",
      "similarity index 100%",
      "rename from x.ts",
      "rename to y.ts",
    ].join("\n");

    const commits = parseCommitDiffs(text);

    expect([...commits.keys()]).toEqual(["aaaa", "bbbb"]);
    expect(commits.get("aaaa")).toEqual([
      {
        path: "src/a.ts",
        binary: false,
        hunks: [
          { removed: ["new FooImpl();"], added: ["new Foo();"] },
          { removed: ["a(", ");"], added: ["a();"] },
        ],
      },
      { path: "logo.png", binary: true, hunks: [] },
    ]);
    expect(commits.get("bbbb")).toEqual([{ path: "y.ts", binary: false, hunks: [] }]);
  });
});
