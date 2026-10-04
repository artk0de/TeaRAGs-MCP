import { describe, expect, it } from "vitest";

import type {
  CallContext,
  FileExtraction,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-vfmfg — the Java import receiver used to name
 * `mapJavaImportToFile`'s synthesised path as the edge target without asking
 * whether the project holds it. For a JDK import that is a phantom file
 * (`java/util/Objects.java`); in a Maven layout it is a phantom even for a
 * project import, because the real file sits under `src/main/java/`. Both
 * reached `cg_symbols_edges_method` and `cg_symbols_edges_file`, where every
 * file-granularity signal reads them. Measured on commons-lang `src/main`:
 * 1079 of 1116 Java file edges and 811 file-only call edges named no file.
 */

const CALLER = "src/main/java/com/app/Caller.java";
const BAR = "src/main/java/com/foo/Bar.java";

const def = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

function projectTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(CALLER, [def("Caller", "Caller", CALLER, []), def("Caller#run", "run", CALLER, ["Caller"])]);
  t.upsertFile(BAR, [def("Bar", "Bar", BAR, []), def("Bar.make", "make", BAR, ["Bar"])]);
  // A project namesake of the JDK class: an import of `java.util.Objects` must
  // never land here.
  t.upsertFile("src/main/java/com/app/util/Objects.java", [
    def("Objects", "Objects", "src/main/java/com/app/util/Objects.java", []),
    def("Objects.requireNonNull", "requireNonNull", "src/main/java/com/app/util/Objects.java", ["Objects"]),
  ]);
  return t;
}

const imports = [
  { importText: "java.util.Objects", startLine: 1 },
  { importText: "com.foo.Bar", startLine: 2 },
];

const ctx = (symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: CALLER,
  callerScope: ["Caller"],
  imports,
  symbolTable,
});

describe("Java import receiver — no phantom external targets (bd tea-rags-mcp-vfmfg)", () => {
  const { resolver } = new JavaLanguage();

  it("emits no edge for a call on a JDK-imported class, and classifies it external", () => {
    const call = { callText: "Objects.requireNonNull(x)", receiver: "Objects", member: "requireNonNull", startLine: 5 };
    const c = ctx(projectTable());
    expect(resolver.resolve(call, c)).toBeNull();
    expect(resolver.targetsExternalImport?.(call, c)).toBe(true);
  });

  it("anchors a file-only edge to the REAL project file when the member is not in the table", () => {
    const call = { callText: "Bar.ghost()", receiver: "Bar", member: "ghost", startLine: 6 };
    expect(resolver.resolve(call, ctx(projectTable()))).toEqual({ targetRelPath: BAR, targetSymbolId: null });
  });

  it("still pins the member in the imported project file", () => {
    const call = { callText: "Bar.make()", receiver: "Bar", member: "make", startLine: 7 };
    const c = ctx(projectTable());
    expect(resolver.resolve(call, c)).toEqual({ targetRelPath: BAR, targetSymbolId: "Bar.make" });
    expect(resolver.targetsExternalImport?.(call, c)).toBe(false);
  });

  it("builds file edges only to files the project holds", () => {
    const extraction: FileExtraction = {
      relPath: CALLER,
      language: "java",
      imports,
      chunks: [],
      fileScope: [],
    };
    const edges = resolver.resolveFileEdges?.(extraction, ctx(projectTable()), []);
    expect(edges?.map((e) => e.targetRelPath)).toEqual([BAR]);
  });
});
