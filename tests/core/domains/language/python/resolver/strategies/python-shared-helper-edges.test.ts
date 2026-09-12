/**
 * The shared Python resolution helpers, exercised at the boundaries every
 * strategy relies on but no strategy test reaches.
 *
 * Each case below is a REFUSAL or a FALLBACK — the two shapes that decide
 * whether a call lands on the right symbol, on a namesake, or nowhere:
 *
 *  - a string that is not a class KEY must never be parsed into one, because a
 *    key is `<relPath>::<dotted FQ>` precisely so two `Base` classes in two
 *    files stay apart;
 *  - a member declared `@classmethod` is reached through the CLASS spelling
 *    (`Cls.m`), and the extends walk has to try both at every hop;
 *  - a run carrying no linearizer must read exactly what it read before the MRO
 *    seam landed, never more;
 *  - the import list is the last evidence available when the symbol table holds
 *    no definition at all.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type {
  AncestorLinearizer,
  LinearizedAncestors,
} from "../../../../../../../src/core/domains/language/kernel/ancestor-walk.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import {
  findPythonImportBinding,
  parsePythonClassKey,
  pythonClassKey,
  pythonClassKeyIsDeclared,
  pythonInheritedMemberType,
  pythonTypeNameIsExternal,
  resolvePythonMemberOnTypeThroughMro,
  resolveTypeFile,
  walkClassExtendsForMethod,
} from "../../../../../../../src/core/domains/language/python/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  readonly symbolId: string;
  readonly scope?: readonly string[];
}

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: [...(def.scope ?? [])],
      })),
    );
  }
  return table;
}

interface CtxParts {
  readonly callerFile?: string;
  readonly callerScope?: string[];
  readonly imports?: ImportRef[];
  readonly table?: InMemoryGlobalSymbolTable;
  readonly classExtends?: Record<string, string>;
  readonly classFieldTypes?: Record<string, Record<string, string>>;
  readonly classFieldTypesByClassKey?: Record<string, Record<string, string>>;
  readonly structuredReturnTypes?: CallContext["structuredReturnTypes"];
}

function ctxWith(parts: CtxParts = {}): CallContext {
  return {
    callerFile: parts.callerFile ?? "app/views.py",
    callerScope: parts.callerScope ?? [],
    imports: parts.imports ?? [],
    symbolTable: parts.table ?? tableWith({ "app/views.py": [{ symbolId: "index" }] }),
    classExtends: parts.classExtends,
    classFieldTypes: parts.classFieldTypes,
    classFieldTypesByClassKey: parts.classFieldTypesByClassKey,
    structuredReturnTypes: parts.structuredReturnTypes,
  } as CallContext;
}

/** A linearizer standing in for a run's real hierarchy: it answers exactly this order. */
function fixedLinearizer(ctx: CallContext, order: readonly string[]): AncestorLinearizer<CallContext> {
  const answer: LinearizedAncestors = { order, closure: "closed" };
  return { ctx, linearize: () => answer };
}

describe("the Python class KEY is a spelling, not a convention", () => {
  it("round-trips a key whose class FQ itself contains dots", () => {
    const key = pythonClassKey("app/models.py", "Outer.Inner");

    expect(parsePythonClassKey(key)).toEqual({ relPath: "app/models.py", classFq: "Outer.Inner" });
  });

  it("refuses every string that is not in that shape rather than inventing a relPath", () => {
    // A bare class name — what the pre-key channels are addressed by.
    expect(parsePythonClassKey("Site")).toBeNull();
    // A dotted FQ, which is a legal class name and must NOT split on the dot.
    expect(parsePythonClassKey("app.models.Site")).toBeNull();
    // The separator with nothing in front of it: no file to attribute to.
    expect(parsePythonClassKey("::Site")).toBeNull();
    // ...and with nothing behind it: no class to address.
    expect(parsePythonClassKey("app/models.py::")).toBeNull();
  });

  it("reports a malformed key as undeclared without consulting the symbol table", () => {
    const table = tableWith({ "app/models.py": [{ symbolId: "Site" }] });
    // `Site` IS declared, but not under a key — the answer is about the key.
    expect(pythonClassKeyIsDeclared("Site", ctxWith({ table }))).toBe(false);
    expect(pythonClassKeyIsDeclared(pythonClassKey("app/models.py", "Site"), ctxWith({ table }))).toBe(true);
    // The right class name in the wrong file is still not this key.
    expect(pythonClassKeyIsDeclared(pythonClassKey("core/models.py", "Site"), ctxWith({ table }))).toBe(false);
  });
});

describe("walkClassExtendsForMethod tries both member spellings at every hop", () => {
  const table = tableWith({
    "app/repo.py": [{ symbolId: "Repo" }],
    "app/base.py": [
      { symbolId: "Base" },
      // A @classmethod: `classifyMethod` files it under the CLASS spelling.
      { symbolId: "Base.from_session", scope: ["Base"] },
    ],
  });

  it("reaches a @classmethod on an ancestor through the class spelling", () => {
    const ctx = ctxWith({ table, classExtends: { Repo: "Base" } });

    expect(walkClassExtendsForMethod("Repo", "from_session", ctx, "strict")).toEqual({
      targetRelPath: "app/base.py",
      targetSymbolId: "Base.from_session",
    });
  });

  it("DROPs rather than falling through when no class in the chain owns the member", () => {
    const ctx = ctxWith({ table, classExtends: { Repo: "Base" } });

    expect(walkClassExtendsForMethod("Repo", "vanished", ctx, "strict")).toBeNull();
  });
});

describe("pythonTypeNameIsExternal answers about the ROOT segment only", () => {
  it("calls a builtin external and an empty name UNKNOWN", () => {
    const ctx = ctxWith();
    const mapper = new PythonImportFileMapper();

    expect(pythonTypeNameIsExternal("dict", ctx, mapper)).toBe(true);
    // `io.BytesIO` is decided by `io`, which nothing here imports — unknown, not external.
    expect(pythonTypeNameIsExternal("io.BytesIO", ctx, mapper)).toBe(false);
    // An empty type name proves nothing; `false` here means UNKNOWN, never "ours".
    expect(pythonTypeNameIsExternal("", ctx, mapper)).toBe(false);
  });
});

describe("findPythonImportBinding falls back to the unaliased name list", () => {
  it("answers from importedNames when the statement carries no binding map", () => {
    const aliased: ImportRef = {
      importText: "app.models",
      startLine: 1,
      importedNames: ["Site"],
      importedBindings: { Alias: "Site" },
    };
    // A walker-1 shaped statement: names, no bindings.
    const plain: ImportRef = { importText: "core.models", startLine: 2, importedNames: ["Job"] };

    expect(findPythonImportBinding([aliased, plain], "Alias")).toEqual({
      imp: aliased,
      localName: "Alias",
      importedName: "Site",
    });
    expect(findPythonImportBinding([aliased, plain], "Job")).toEqual({
      imp: plain,
      localName: "Job",
      importedName: "Job",
    });
    expect(findPythonImportBinding([aliased, plain], "Nothing")).toBeNull();
  });
});

describe("resolveTypeFile's last resort is the import list itself", () => {
  it("attributes a type the symbol table does not hold to the module the import names", () => {
    const table = tableWith({
      "app/views.py": [{ symbolId: "index" }],
      // A module named for its class whose symbols never made it into the table.
      "app/Widget.py": [],
    });
    const ctx = ctxWith({
      table,
      imports: [
        { importText: "app.Widget", startLine: 1, importedNames: ["Widget"], importedBindings: { Widget: "Widget" } },
      ],
    });

    expect(resolveTypeFile("Widget", ctx, new PythonImportFileMapper())).toBe("app/Widget.py");
  });
});

describe("resolvePythonMemberOnTypeThroughMro separates UNBOUND from a hierarchy that closed", () => {
  it("reports unbound — no hierarchy entered — when the type name binds no project file", () => {
    const ctx = ctxWith();

    const resolution = resolvePythonMemberOnTypeThroughMro(
      "Nowhere",
      "run",
      ctx,
      "strict",
      new PythonImportFileMapper(),
      fixedLinearizer(ctx, []),
    );

    expect(resolution).toEqual({ target: null, closure: "unbound" });
  });

  it("skips a linearized entry that is not a class key instead of resolving against it", () => {
    const table = tableWith({
      "app/views.py": [{ symbolId: "index" }],
      "app/models.py": [{ symbolId: "Site" }],
      "app/base.py": [{ symbolId: "NetBoxModel" }, { symbolId: "NetBoxModel#save", scope: ["NetBoxModel"] }],
    });
    const ctx = ctxWith({
      table,
      imports: [
        { importText: "app.models", startLine: 1, importedNames: ["Site"], importedBindings: { Site: "Site" } },
      ],
    });
    const siteKey = pythonClassKey("app/models.py", "Site");

    const resolution = resolvePythonMemberOnTypeThroughMro(
      "Site",
      "save",
      ctx,
      "strict",
      new PythonImportFileMapper(),
      // A hierarchy carrying a bare class name where a key belongs: the walk
      // must step over it and keep going rather than stop or guess.
      fixedLinearizer(ctx, [siteKey, "NetBoxModel", pythonClassKey("app/base.py", "NetBoxModel")]),
    );

    expect(resolution.target).toEqual({ targetRelPath: "app/base.py", targetSymbolId: "NetBoxModel#save" });
  });
});

describe("pythonInheritedMemberType stays at the pre-seam reach when the run cannot go further", () => {
  const table = tableWith({
    "app/views.py": [{ symbolId: "index" }],
    "app/models.py": [{ symbolId: "Site" }],
    "app/base.py": [{ symbolId: "NetBoxModel" }],
  });

  it("gives up when the receiver type names no class the run declares", () => {
    const ctx = ctxWith({ table, classFieldTypesByClassKey: {} });

    expect(
      pythonInheritedMemberType("Ghost", "objects", "instance", ctx, new PythonImportFileMapper(), undefined),
    ).toBeUndefined();
  });

  it("reads the own class only on a run carrying no linearizer", () => {
    const ctx = ctxWith({
      callerFile: "app/models.py",
      table,
      classFieldTypesByClassKey: { [pythonClassKey("app/base.py", "NetBoxModel")]: { objects: "RestrictedQuerySet" } },
    });

    // The field lives on the BASE class; with no hierarchy to walk it is out of reach.
    expect(
      pythonInheritedMemberType("Site", "objects", "instance", ctx, new PythonImportFileMapper(), undefined),
    ).toBeUndefined();

    // The same read on the class that owns the field answers directly.
    expect(
      pythonInheritedMemberType(
        "NetBoxModel",
        "objects",
        "instance",
        ctxWith({
          callerFile: "app/base.py",
          table,
          classFieldTypesByClassKey: {
            [pythonClassKey("app/base.py", "NetBoxModel")]: { objects: "RestrictedQuerySet" },
          },
        }),
        new PythonImportFileMapper(),
        undefined,
      ),
    ).toEqual({ form: "instance", name: "RestrictedQuerySet" });
  });

  it("reads an ancestor's `-> Self` as the class the RECEIVER names (bd tea-rags-mcp-w205u)", () => {
    // polar: `AccountRepository.from_session(s)` where `from_session` is a
    // `@classmethod` on `RepositoryBase` annotated `-> Self`. The declaring
    // class is the wrong answer — every member the chain then asks for lives on
    // the subclass. 12 rows.
    const repos = tableWith({
      "app/account.py": [{ symbolId: "AccountRepository" }],
      "app/base.py": [{ symbolId: "RepositoryBase" }],
    });
    const ctx = ctxWith({
      callerFile: "app/account.py",
      table: repos,
      structuredReturnTypes: { "RepositoryBase.from_session": { form: "instance", name: "Self" } },
      classFieldTypesByClassKey: {},
    });

    expect(
      pythonInheritedMemberType(
        "AccountRepository",
        "from_session",
        "class",
        ctx,
        new PythonImportFileMapper(),
        fixedLinearizer(ctx, [
          pythonClassKey("app/account.py", "AccountRepository"),
          pythonClassKey("app/base.py", "RepositoryBase"),
        ]),
      ),
    ).toEqual({ form: "instance", name: "AccountRepository" });
  });

  it("steps over an ancestor entry that is not a class key and keeps walking", () => {
    const ctx = ctxWith({
      callerFile: "app/models.py",
      table,
      classFieldTypes: { NetBoxModel: { objects: "RestrictedQuerySet" } },
      classFieldTypesByClassKey: {},
    });
    const siteKey = pythonClassKey("app/models.py", "Site");

    const found = pythonInheritedMemberType(
      "Site",
      "objects",
      "instance",
      ctx,
      new PythonImportFileMapper(),
      fixedLinearizer(ctx, [siteKey, "NetBoxModel", pythonClassKey("app/base.py", "NetBoxModel")]),
    );

    expect(found).toEqual({ form: "instance", name: "RestrictedQuerySet" });
  });
});
