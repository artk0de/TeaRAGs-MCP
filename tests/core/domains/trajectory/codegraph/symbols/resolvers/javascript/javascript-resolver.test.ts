import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import {
  JavascriptCallResolver,
  mapJavascriptImportToFile,
} from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/javascript/javascript-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("mapJavascriptImportToFile", () => {
  it("relative import resolves with .js extension by default", () => {
    expect(mapJavascriptImportToFile("./foo", "pkg/main.js")).toBe("pkg/foo.js");
  });

  it("preserves explicit .js extension", () => {
    expect(mapJavascriptImportToFile("./foo.js", "pkg/main.js")).toBe("pkg/foo.js");
  });

  it("preserves explicit .mjs extension", () => {
    expect(mapJavascriptImportToFile("./foo.mjs", "pkg/main.mjs")).toBe("pkg/foo.mjs");
  });

  it("parent path resolves with normalization", () => {
    expect(mapJavascriptImportToFile("../foo", "pkg/sub/x.js")).toBe("pkg/foo.js");
  });

  it("returns null for bare specifiers (npm packages)", () => {
    expect(mapJavascriptImportToFile("lodash", "x.js")).toBeNull();
  });
});

describe("JavascriptCallResolver", () => {
  it("resolves receiver-matched relative import to known file", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/foo.js", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "pkg/foo.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      ctx("pkg/main.js", [{ importText: "./foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
    expect(target?.targetSymbolId).toBe("bar");
  });

  it("matches import basename ignoring .js extension", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/foo.js", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "pkg/foo.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      ctx("pkg/main.js", [{ importText: "./foo.js", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
  });

  it("falls back to global short-name when no receiver", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.js", [
      { symbolId: "doThing", fqName: "doThing", shortName: "doThing", relPath: "helpers.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "doThing()", receiver: null, member: "doThing", startLine: 1 },
      ctx("main.js", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.js");
  });

  it("returns target file with null symbol id when import matches but symbol unknown", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "foo.ghost()", receiver: "foo", member: "ghost", startLine: 1 },
      ctx("pkg/main.js", [{ importText: "./foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("returns null for bare specifier imports (out of scope)", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "lodash.get()", receiver: "lodash", member: "get", startLine: 1 },
      ctx("main.js", [{ importText: "lodash", startLine: 1 }], t),
    );
    expect(target).toBeNull();
  });
});
