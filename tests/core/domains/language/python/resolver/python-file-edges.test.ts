/**
 * Python's `resolveFileEdges` override and the two verdict branches Task 6 of
 * `docs/superpowers/plans/2026-09-08-python-import-file-mapper.md` decided
 * differently from the plan's illustrative snippet (bd tea-rags-mcp-qqwbw).
 *
 * The file graph no longer comes from pushing a synthesised call through the
 * resolve chain, so it is pinned here rather than through the chain's tests.
 * The `unknown` branches are pinned because decision 1 makes them behave
 * DIFFERENTLY from `external`: "I cannot tell" keeps the pre-seam fallback,
 * "I know it is a library" contributes nothing.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/index.js";
import { PythonExternalVocabulary } from "../../../../../../src/core/domains/language/python/resolver/python-external-vocabulary.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { resolveTypeFile } from "../../../../../../src/core/domains/language/python/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (name: string, relPath: string): NamedSymbol => ({
  symbolId: name,
  fqName: name,
  shortName: name,
  relPath,
  scope: [],
});

const tableWith = (...files: [string, string[]][]): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, names] of files) {
    table.upsertFile(
      relPath,
      names.map((n) => sym(n, relPath)),
    );
  }
  return table;
};

const extraction = (relPath: string, importTexts: string[]): FileExtraction => ({
  relPath,
  language: "python",
  imports: importTexts.map((importText, i) => ({ importText, startLine: i + 1 })),
  chunks: [],
  fileScope: [],
});

const ctxFor = (callerFile: string, ext: FileExtraction, symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile,
  callerScope: [],
  imports: ext.imports,
  symbolTable,
});

describe("PythonCallResolver#resolveFileEdges", () => {
  it("answers a package import with its __init__.py and a module import with the module file", () => {
    const symbolTable = tableWith(
      ["netbox/dcim/models/__init__.py", ["Device"]],
      ["netbox/dcim/api.py", ["router"]],
      ["netbox/app.py", ["main"]],
    );
    const ext = extraction("netbox/app.py", ["dcim.models", "dcim.api"]);
    const edges = new PythonCallResolver().resolveFileEdges(ext, ctxFor("netbox/app.py", ext, symbolTable));
    expect(edges).toEqual([
      { targetRelPath: "netbox/dcim/models/__init__.py", importText: "dcim.models" },
      { targetRelPath: "netbox/dcim/api.py", importText: "dcim.api" },
    ]);
  });

  it("emits nothing for a stdlib import and nothing for a self-import", () => {
    const symbolTable = tableWith(["pkg/__init__.py", []], ["pkg/main.py", ["main"]]);
    const ext = extraction("pkg/__init__.py", ["json", "os.path", "."]);
    const edges = new PythonCallResolver().resolveFileEdges(ext, ctxFor("pkg/__init__.py", ext, symbolTable));
    expect(edges).toEqual([]);
  });
});

describe("resolveTypeFile — third pass verdict handling", () => {
  it("attributes nothing when the import naming the type is EXTERNAL", () => {
    // `rest_framework` is not in the table and the table is non-empty, so the
    // mapper can say external — attributing `Serializer` to a fabricated
    // `rest_framework/Serializer.py` is the phantom this seam removes.
    const symbolTable = tableWith(["views.py", ["View"]]);
    const ctx: CallContext = {
      callerFile: "views.py",
      callerScope: [],
      imports: [{ importText: "rest_framework.Serializer", startLine: 1 }],
      symbolTable,
    };
    expect(resolveTypeFile("Serializer", ctx, new PythonImportFileMapper())).toBeNull();
  });

  it("keeps the pre-seam synthesised path when the verdict is UNKNOWN", () => {
    // A relative import can never be external, so a miss is `unknown` and
    // decision 1 keeps today's conservative fallback rather than dropping the
    // attribution outright.
    const ctx: CallContext = {
      callerFile: "views.py",
      callerScope: [],
      imports: [{ importText: ".lib.Serializer", startLine: 1 }],
      symbolTable: new InMemoryGlobalSymbolTable(),
    };
    expect(resolveTypeFile("Serializer", ctx, new PythonImportFileMapper())).toBe("lib/Serializer.py");
  });
});

describe("PythonExternalVocabulary — stdlib precedence over root inference", () => {
  it("still claims a stdlib receiver when the project has a same-named package under an ancestor root", () => {
    // The mapper probes the caller's ancestors before the stdlib snapshot, so
    // `src/flask/json/__init__.py` would otherwise make `import json` look
    // first-party. Which module the interpreter binds is a sys.path question.
    const symbolTable = tableWith(["src/flask/__init__.py", ["Flask"]], ["src/flask/json/__init__.py", ["dumps"]]);
    const ctx: CallContext = {
      callerFile: "src/flask/tag.py",
      callerScope: [],
      imports: [{ importText: "json", startLine: 1 }],
      symbolTable,
    };
    expect(new PythonExternalVocabulary().isQualifiedReceiverExternal("json.dumps", ctx, 3)).toBe(true);
  });
});
