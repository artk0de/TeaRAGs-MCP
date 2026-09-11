/**
 * A type name that an import ALIASED (bd tea-rags-mcp-w205u, E4.6c).
 *
 * polar writes `from polar.order.schemas import Order as OrderSchema` and then
 * `data: OrderSchema` on a class, while the member lives on `Order`'s ancestor
 * `OrderBase` — 11 rows. The annotation channel records the LOCAL name, which
 * names nothing: `lookupPythonSymbolsByShortName("OrderSchema")` is empty, and
 * `resolveTypeFile`'s third pass matches the import TEXT's last segment
 * (`schemas`), not the alias. The class key needs the SOURCE name, and the
 * import statement is what says which one it is.
 *
 * The alias arm runs only on a MISS, so everything that resolves today resolves
 * to the same class.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonSelfFieldSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-self-field.js";
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

function selfField(): PythonSelfFieldSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonSelfFieldSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const callData: CallRef = {
  callText: "self.data.total_amount()",
  receiver: "self.data",
  member: "total_amount",
  startLine: 20,
};

/** `Order` in `order/schemas.py`, its member declared on the base `OrderBase`. */
const polarTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "order/schemas.py": [{ symbolId: "Order" }],
    "order/base.py": [{ symbolId: "OrderBase" }, { symbolId: "OrderBase#total_amount", scope: ["OrderBase"] }],
    "web/views.py": [{ symbolId: "OrderView" }],
  });

function ctxWith(imports: readonly ImportRef[], fieldType: string): CallContext {
  return {
    callerFile: "web/views.py",
    callerScope: ["OrderView"],
    imports: [...imports],
    symbolTable: polarTable(),
    classAncestors: { "order/schemas.py::Order": ["order.base::OrderBase"] },
    classFieldTypes: { OrderView: { data: fieldType } },
  };
}

const aliasImport: ImportRef = {
  importText: "order.schemas",
  startLine: 1,
  importedNames: ["Order"],
  importedBindings: { OrderSchema: "Order" },
};

describe("a type name bound by an ALIASING import", () => {
  it("resolves the member on the SOURCE class's ancestor", () => {
    expect(selfField().attempt(callData, ctxWith([aliasImport], "OrderSchema"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "order/base.py", targetSymbolId: "OrderBase#total_amount" },
    });
  });

  it("is byte-identical for an UNALIASED import of the same class", () => {
    const plain: ImportRef = {
      importText: "order.schemas",
      startLine: 1,
      importedNames: ["Order"],
      importedBindings: { Order: "Order" },
    };
    expect(selfField().attempt(callData, ctxWith([plain], "Order"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "order/base.py", targetSymbolId: "OrderBase#total_amount" },
    });
  });

  it("does not answer for a local name no import bound at all", () => {
    const outcome = selfField().attempt(callData, ctxWith([aliasImport], "MysteryShape"));
    expect(outcome.kind).not.toBe("resolved");
  });

  it("does not answer when the aliasing import leaves the project", () => {
    const external: ImportRef = {
      importText: "pydantic.main",
      startLine: 1,
      importedNames: ["BaseModel"],
      importedBindings: { OrderSchema: "BaseModel" },
    };
    const outcome = selfField().attempt(callData, ctxWith([external], "OrderSchema"));
    expect(outcome.kind).not.toBe("resolved");
  });
});
