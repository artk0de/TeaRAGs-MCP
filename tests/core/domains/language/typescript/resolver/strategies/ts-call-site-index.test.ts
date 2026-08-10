/**
 * The call-site index behind the TypeScript checker passes' two node finders
 * (bd tea-rags-mcp-skzu9).
 *
 * `findReceiverExpression` and `findCallExpression` used to walk the SourceFile
 * from the top on every question, and the guard plus passes 12-14 plus the
 * oracle harness ask about the SAME file thousands of times per run — one walk
 * each. The answers were always going to be identical, so the walk is the thing
 * to do once; these tests pin BOTH halves of that: the single walk, and that
 * indexing has not changed a single answer.
 *
 * The equivalence cases are chosen where a careless index would diverge from the
 * old first-match-then-stop traversal — a nested call, and a line carrying both
 * a bare and a property-access call of the same name.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { findCallExpression } from "../../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import { findReceiverExpression } from "../../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-shared.js";

function parse(fileName: string, code: string): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true);
}

/**
 * A SourceFile that counts position lookups. Every walk resolves a node's start
 * to a line through this method, so the counter standing still across a second
 * question is exactly "the file was not walked again".
 */
function countingSourceFile(fileName: string, code: string): { sourceFile: ts.SourceFile; lookups: () => number } {
  const sourceFile = parse(fileName, code);
  let calls = 0;
  const original = sourceFile.getLineAndCharacterOfPosition.bind(sourceFile);
  sourceFile.getLineAndCharacterOfPosition = (position: number): ts.LineAndCharacter => {
    calls++;
    return original(position);
  };
  return { sourceFile, lookups: () => calls };
}

describe("TypeScript call-site lookup", () => {
  const multiCall = ["alpha.first();", "beta.second();", "third();", "gamma.fourth();", "delta.fifth();", ""].join(
    "\n",
  );

  it("walks a source file at most once however many call sites are asked about", () => {
    const { sourceFile, lookups } = countingSourceFile("src/multi.ts", multiCall);

    findReceiverExpression(sourceFile, 1, "first");
    const afterFirstQuestion = lookups();

    findReceiverExpression(sourceFile, 2, "second");
    findCallExpression(sourceFile, 3, "third");
    findReceiverExpression(sourceFile, 4, "fourth");
    findCallExpression(sourceFile, 5, "fifth");
    findReceiverExpression(sourceFile, 99, "absent");

    expect(lookups()).toBe(afterFirstQuestion);
  });

  it("re-answers a member absent from the file without re-walking it", () => {
    const { sourceFile, lookups } = countingSourceFile("src/multi.ts", multiCall);

    expect(findReceiverExpression(sourceFile, 1, "missing")).toBeNull();
    const afterFirstQuestion = lookups();

    expect(findReceiverExpression(sourceFile, 1, "missing")).toBeNull();
    expect(findCallExpression(sourceFile, 1, "missing")).toBeNull();
    expect(lookups()).toBe(afterFirstQuestion);
  });

  it("keeps the outermost call when the same member nests on one line", () => {
    const sourceFile = parse("src/nested.ts", "outer.run(inner.run());\n");

    const receiver = findReceiverExpression(sourceFile, 1, "run");
    const call = findCallExpression(sourceFile, 1, "run");

    expect(receiver?.getText(sourceFile)).toBe("outer");
    expect(call?.getText(sourceFile)).toBe("outer.run(inner.run())");
  });

  it("answers the bare call and the property-access receiver independently on one line", () => {
    const sourceFile = parse("src/mixed.ts", "run(); helper.run();\n");

    // The bare call comes first in traversal order, so it is what the
    // call-expression question returns — while the receiver question skips it,
    // because a bare call has no receiver at all.
    expect(findCallExpression(sourceFile, 1, "run")?.getText(sourceFile)).toBe("run()");
    expect(findReceiverExpression(sourceFile, 1, "run")?.getText(sourceFile)).toBe("helper");
  });

  it("separates identical coordinates across different source files", () => {
    const first = parse("src/a.ts", "left.run();\n");
    const second = parse("src/b.ts", "right.run();\n");

    expect(findReceiverExpression(first, 1, "run")?.getText(first)).toBe("left");
    expect(findReceiverExpression(second, 1, "run")?.getText(second)).toBe("right");
    expect(findReceiverExpression(first, 1, "run")?.getText(first)).toBe("left");
  });

  it("distinguishes the same member on different lines", () => {
    const sourceFile = parse("src/lines.ts", "one.run();\ntwo.run();\n");

    expect(findReceiverExpression(sourceFile, 1, "run")?.getText(sourceFile)).toBe("one");
    expect(findReceiverExpression(sourceFile, 2, "run")?.getText(sourceFile)).toBe("two");
  });
});
