import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonConeTypeLocator } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-cone-type-locator.js";
import { CONE_MAX_DEFAULT } from "../../../../../../../src/core/domains/language/python/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function makeCtx(imports: { importText: string; startLine: number }[], table: InMemoryGlobalSymbolTable): CallContext {
  return { callerFile: "app/caller.py", callerScope: [], imports, symbolTable: table };
}

describe("PythonConeTypeLocator", () => {
  const locator = new PythonConeTypeLocator({ mode: "strict", coneMax: CONE_MAX_DEFAULT });

  describe("resolveTypeFile", () => {
    it("resolves a bare type name unique in the symbol table", () => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/animal.py", [
        { symbolId: "Animal", fqName: "Animal", shortName: "Animal", relPath: "app/models/animal.py", scope: [] },
      ]);
      const ctx = makeCtx([], table);
      expect(locator.resolveTypeFile("Animal", ctx)).toBe("app/models/animal.py");
    });

    it("strips a module qualifier before resolving — `module.ClassName` → bare `ClassName`", () => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/dog.py", [
        { symbolId: "Dog", fqName: "Dog", shortName: "Dog", relPath: "app/models/dog.py", scope: [] },
      ]);
      const ctx = makeCtx([], table);
      // Qualified form: `app.models.Dog` — lastSegment strips to `Dog`.
      expect(locator.resolveTypeFile("app.models.Dog", ctx)).toBe("app/models/dog.py");
    });

    it("returns null when the type is absent from the table and no import resolves it", () => {
      const table = new InMemoryGlobalSymbolTable();
      const ctx = makeCtx([], table);
      expect(locator.resolveTypeFile("Ghost", ctx)).toBeNull();
    });
  });

  describe("findDirectMethod", () => {
    it("returns the method target when the bare type name matches the scope tail (common case)", () => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/dog.py", [
        { symbolId: "Dog", fqName: "Dog", shortName: "Dog", relPath: "app/models/dog.py", scope: [] },
        {
          symbolId: "Dog#speak",
          fqName: "Dog#speak",
          shortName: "speak",
          relPath: "app/models/dog.py",
          scope: ["Dog"],
        },
      ]);
      const ctx = makeCtx([], table);
      const result = locator.findDirectMethod("Dog", "speak", ctx);
      expect(result?.targetRelPath).toBe("app/models/dog.py");
      expect(result?.targetSymbolId).toBe("Dog#speak");
    });

    it("returns null when the type file is unknown (no table entry, no import)", () => {
      const table = new InMemoryGlobalSymbolTable();
      const ctx = makeCtx([], table);
      expect(locator.findDirectMethod("Ghost", "run", ctx)).toBeNull();
    });

    it("returns null when the method is not declared on the type's file", () => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/cat.py", [
        { symbolId: "Cat", fqName: "Cat", shortName: "Cat", relPath: "app/models/cat.py", scope: [] },
        // `speak` exists but on a DIFFERENT file — must not be attributed.
        {
          symbolId: "Dog#speak",
          fqName: "Dog#speak",
          shortName: "speak",
          relPath: "app/models/dog.py",
          scope: ["Dog"],
        },
      ]);
      const ctx = makeCtx([], table);
      expect(locator.findDirectMethod("Cat", "speak", ctx)).toBeNull();
    });

    it("resolves via the qualified typeName tail — scope stores the full qualified form", () => {
      // Scenario: the codegraph walker emits scope as ["app.models.Animal"] (fully
      // qualified). `findDirectMethod("app.models.Animal", "speak", ctx)` must
      // match the candidate whose `scope.last === "app.models.Animal"` via the
      // `tail === typeName` branch (not the `tail === bareType` branch, since
      // bareType = "Animal" ≠ "app.models.Animal").
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/animal.py", [
        {
          symbolId: "app.models.Animal",
          fqName: "app.models.Animal",
          shortName: "Animal",
          relPath: "app/models/animal.py",
          scope: [],
        },
        {
          symbolId: "app.models.Animal#speak",
          fqName: "app.models.Animal#speak",
          shortName: "speak",
          relPath: "app/models/animal.py",
          // scope tail is the fully qualified class name — the `tail === typeName` path
          scope: ["app.models.Animal"],
        },
      ]);
      const ctx = makeCtx([], table);
      // `resolveTypeFile` strips to "Animal" → unique match → "app/models/animal.py".
      // Filter checks `tail === typeName` ("app.models.Animal" === "app.models.Animal") → passes.
      const result = locator.findDirectMethod("app.models.Animal", "speak", ctx);
      expect(result?.targetRelPath).toBe("app/models/animal.py");
      expect(result?.targetSymbolId).toBe("app.models.Animal#speak");
    });
  });
});
