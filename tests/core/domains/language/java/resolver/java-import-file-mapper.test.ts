import { describe, expect, it } from "vitest";

import type { CallContext, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavaImportFileMapper } from "../../../../../../src/core/domains/language/java/resolver/java-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-vfmfg — which project file a Java import names, answered
 * from symbol-table membership. The synthesised `com/foo/Bar.java` names no
 * file in a Maven layout (`src/main/java/com/foo/Bar.java`), and for a JDK
 * import (`java.util.Objects`) it names a file the project cannot contain.
 */

const classDef = (name: string, relPath: string): NamedSymbol => ({
  symbolId: name,
  fqName: name,
  shortName: name,
  relPath,
  scope: [],
});

const ctxOver = (...files: [string, NamedSymbol[]][]): CallContext => {
  const symbolTable = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) symbolTable.upsertFile(relPath, defs);
  return { callerFile: "src/main/java/com/app/Caller.java", callerScope: [], imports: [], symbolTable };
};

const mapper = new JavaImportFileMapper();
const CALLER = "src/main/java/com/app/Caller.java";

describe("JavaImportFileMapper", () => {
  it("maps a class import to the project file under its source root", () => {
    const ctx = ctxOver(
      [CALLER, [classDef("Caller", CALLER)]],
      ["src/main/java/com/foo/Bar.java", [classDef("Bar", "src/main/java/com/foo/Bar.java")]],
    );
    expect(mapper.mapImportToFile("com.foo.Bar", CALLER, ctx)).toEqual({
      kind: "project",
      relPath: "src/main/java/com/foo/Bar.java",
    });
  });

  it("maps a static member import to the file of its class", () => {
    const ctx = ctxOver(
      [CALLER, [classDef("Caller", CALLER)]],
      ["src/main/java/com/foo/Bar.java", [classDef("Bar", "src/main/java/com/foo/Bar.java")]],
    );
    expect(mapper.mapImportToFile("com.foo.Bar.helper", CALLER, ctx)).toEqual({
      kind: "project",
      relPath: "src/main/java/com/foo/Bar.java",
    });
  });

  it("maps an import whose synthesised path IS the relPath (no source root)", () => {
    const ctx = ctxOver(
      [CALLER, [classDef("Caller", CALLER)]],
      ["com/foo/Bar.java", [classDef("Bar", "com/foo/Bar.java")]],
    );
    expect(mapper.mapImportToFile("com.foo.Bar", CALLER, ctx)).toEqual({
      kind: "project",
      relPath: "com/foo/Bar.java",
    });
  });

  it("answers external for a class the project does not hold (JDK import)", () => {
    const ctx = ctxOver([CALLER, [classDef("Caller", CALLER)]]);
    expect(mapper.mapImportToFile("java.util.Objects", CALLER, ctx)).toEqual({ kind: "external" });
  });

  it("does not take a same-named class in ANOTHER package as the import's file", () => {
    const ctx = ctxOver(
      [CALLER, [classDef("Caller", CALLER)]],
      ["src/main/java/com/app/Objects.java", [classDef("Objects", "src/main/java/com/app/Objects.java")]],
    );
    expect(mapper.mapImportToFile("java.util.Objects", CALLER, ctx)).toEqual({ kind: "external" });
  });

  it("answers unknown for a wildcard import — a package is not a file", () => {
    const ctx = ctxOver([CALLER, [classDef("Caller", CALLER)]]);
    expect(mapper.mapImportToFile("com.foo.*", CALLER, ctx)).toEqual({ kind: "unknown" });
  });

  it("answers unknown against an empty symbol table — nothing to decide from", () => {
    const ctx = ctxOver();
    expect(mapper.mapImportToFile("java.util.Objects", CALLER, ctx)).toEqual({ kind: "unknown" });
  });

  it("answers unknown when two source roots hold the same class", () => {
    const ctx = ctxOver(
      [CALLER, [classDef("Caller", CALLER)]],
      ["a/src/main/java/com/foo/Bar.java", [classDef("Bar", "a/src/main/java/com/foo/Bar.java")]],
      ["b/src/main/java/com/foo/Bar.java", [classDef("Bar", "b/src/main/java/com/foo/Bar.java")]],
    );
    expect(mapper.mapImportToFile("com.foo.Bar", CALLER, ctx)).toEqual({ kind: "unknown" });
  });
});
