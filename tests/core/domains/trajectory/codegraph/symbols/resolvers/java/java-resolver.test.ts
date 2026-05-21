import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import {
  JavaCallResolver,
  mapJavaImportToFile,
} from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/java/java-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("mapJavaImportToFile", () => {
  it("translates `com.foo.Bar` → com/foo/Bar.java", () => {
    expect(mapJavaImportToFile("com.foo.Bar")).toBe("com/foo/Bar.java");
  });

  it("wildcards return null (point at directory, not file)", () => {
    expect(mapJavaImportToFile("com.foo.*")).toBeNull();
  });

  it("static import drops trailing method segment", () => {
    expect(mapJavaImportToFile("com.foo.Bar.method")).toBe("com/foo/Bar.java");
  });

  it("returns null when no uppercase class segment found", () => {
    expect(mapJavaImportToFile("all.lowercase.package")).toBeNull();
  });
});

describe("JavaCallResolver", () => {
  it("resolves `Bar.method()` to com/foo/Bar.java", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("com/foo/Bar.java", [
      {
        symbolId: "Bar.method",
        fqName: "Bar.method",
        shortName: "method",
        relPath: "com/foo/Bar.java",
        scope: ["Bar"],
      },
    ]);
    const target = r.resolve(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.Bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
  });

  it("wildcards do not match — falls through to global lookup", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("com/foo/Bar.java", [
      {
        symbolId: "Bar.method",
        fqName: "Bar.method",
        shortName: "method",
        relPath: "com/foo/Bar.java",
        scope: ["Bar"],
      },
    ]);
    const target = r.resolve(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.*", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
  });

  it("returns null when nothing resolves", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "Ghost.find()", receiver: "Ghost", member: "find", startLine: 1 },
      ctx("X.java", [], t),
    );
    expect(target).toBeNull();
  });

  // When the import resolves to a target file but the symbol table has
  // no matching short-name (e.g. file isn't indexed yet, partial reindex,
  // or symbol declared inside a method) the resolver still anchors the
  // edge to the file path. `targetSymbolId: null` signals "file known,
  // symbol unknown" to downstream consumers. Drives the
  // `return { targetRelPath: targetFile, targetSymbolId: null }` branch
  // (line 32 of java-resolver.ts).
  it("returns target file with null symbol id when import resolves but symbol unknown", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // No symbol-table entry for `Bar` → candidates[] is empty → fall
    // through to the file-level anchor with null symbol id.
    const target = r.resolve(
      { callText: "Bar.ghost()", receiver: "Bar", member: "ghost", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.Bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
    expect(target?.targetSymbolId).toBeNull();
  });
});
