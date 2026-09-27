import Parser from "tree-sitter";
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import { DEFAULT_AMBIGUOUS_RESOLVE_MODE } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavaCallResolver } from "../../../../../../src/core/domains/language/java/resolver/java-resolver.js";
import { extractFromJavaFile } from "../../../../../../src/core/domains/language/java/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function extract(src: string, chunk: { symbolId: string; scope: string[]; startLine: number; endLine: number }) {
  const parser = new Parser();
  parser.setLanguage(JavaLang);
  return extractFromJavaFile({
    tree: parser.parse(src),
    code: src,
    relPath: "Protest.java",
    language: "java",
    chunks: [chunk],
  });
}

const PROTEST = ["class Protest {", "  int size() {", "    return new Latest().version();", "  }", "}", ""].join("\n");

const SIZE_CHUNK = { symbolId: "Protest#size", scope: ["Protest"], startLine: 2, endLine: 4 };

/**
 * bd tea-rags-mcp-52gqn — a method called on a freshly constructed object.
 *
 * `new Latest().version()` reached the resolver as a call whose receiver was the
 * raw expression text `new Latest()`: no binding typed it, and every receiver
 * pass reads a parenthesized receiver as an untyped chain and drops it. So
 * `get_callees Protest#size` came back empty while the equivalent typed local
 * (`Latest l = new Latest(); l.version()`) resolved. The constructed type is
 * written right there in the expression; the walker binds the receiver to it.
 */
describe("extractFromJavaFile — method call on a constructed receiver (bd tea-rags-mcp-52gqn)", () => {
  it("binds the `new X()` receiver to the constructed type X at the call's line", () => {
    const chunk = extract(PROTEST, SIZE_CHUNK).chunks[0];
    expect(chunk.calls).toEqual([
      { callText: "new Latest().version()", receiver: "new Latest()", member: "version", startLine: 3 },
    ]);
    expect(chunk.localBindings).toEqual({ "new Latest()": [{ line: 3, type: "Latest" }] });
  });

  it("strips generics and sees through parentheses (`(new Box<String>()).get()` -> Box)", () => {
    const src = ["class Protest {", "  int size() {", "    return (new Box<String>()).get();", "  }", "}", ""].join(
      "\n",
    );
    expect(extract(src, SIZE_CHUNK).chunks[0].localBindings).toEqual({
      "(new Box<String>())": [{ line: 3, type: "Box" }],
    });
  });

  it("resolves the call end to end to the constructed type's method", () => {
    const chunk = extract(PROTEST, SIZE_CHUNK).chunks[0];
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("Latest.java", [
      { symbolId: "Latest", fqName: "Latest", shortName: "Latest", relPath: "Latest.java", scope: [] },
      {
        symbolId: "Latest#version",
        fqName: "Latest#version",
        shortName: "version",
        relPath: "Latest.java",
        scope: ["Latest"],
      },
    ]);
    table.upsertFile("Other.java", [
      {
        symbolId: "Other#version",
        fqName: "Other#version",
        shortName: "version",
        relPath: "Other.java",
        scope: ["Other"],
      },
    ]);
    const target = new JavaCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE).resolve(chunk.calls[0], {
      callerFile: "Protest.java",
      callerScope: ["Protest"],
      imports: [],
      symbolTable: table,
      localBindings: chunk.localBindings,
    });
    expect(target).toEqual({ targetRelPath: "Latest.java", targetSymbolId: "Latest#version" });
  });
});
