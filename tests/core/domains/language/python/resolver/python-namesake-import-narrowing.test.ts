/**
 * Namesake narrowing by the CALLER's own import binding (bd
 * tea-rags-mcp-1v12o.1.5, E5.1a).
 *
 * Two halves refuse the same 79 rows for two different reasons, measured in
 * E5.0a's block (E):
 *
 *   - The TYPE-NAME half (`resolveTypeFile`) does narrow by imports, but it
 *     narrows by the caller's import SET: every file any import maps to. polar
 *     writes `from polar.models import Subscription` AND
 *     `from polar.subscription.schemas import SubscriptionChargePreview` in the
 *     same file, and `schemas.py` declares its own `Subscription`, so two
 *     candidates survive and the pass refuses. The binding for THIS name names
 *     exactly one of them.
 *   - The CALL-RESULT half (`pythonCallBindingType`) has no narrowing at all:
 *     it reads a bare callee's return type only when the corpus declares one
 *     def of that name. polar declares `get_client` in six files.
 *
 * One funnel answers both: `pythonImportBoundFile`.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, ImportRef, ModuleReexport } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { createPythonCallBindingPorts } from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import {
  pythonCallBindingType,
  pythonImportBoundFile,
  resolveTypeFile,
} from "../../../../../../src/core/domains/language/python/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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

const importOf = (importText: string, name: string, local = name): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [local],
  importedBindings: { [local]: name },
});

/** polar's shape: a model and a schema under one name, plus the SDK's two copies. */
const polarTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "server/polar/models/__init__.py": [],
    "server/polar/models/subscription.py": [
      { symbolId: "Subscription" },
      { symbolId: "Subscription#can_resume", scope: ["Subscription"] },
    ],
    "server/polar/subscription/__init__.py": [],
    "server/polar/subscription/schemas.py": [{ symbolId: "Subscription" }, { symbolId: "SubscriptionChargePreview" }],
    "server/polar/customer_portal/service/subscription.py": [{ symbolId: "CustomerSubscriptionService" }],
  });

const POLAR_REEXPORTS: Record<string, ModuleReexport[]> = {
  "server/polar/models/__init__.py": [
    { exportedName: "Subscription", sourceModule: ".subscription", sourceName: "Subscription" },
  ],
};

function polarCtx(imports: readonly ImportRef[]): CallContext {
  return {
    callerFile: "server/polar/customer_portal/service/subscription.py",
    callerScope: [],
    imports: [...imports],
    symbolTable: polarTable(),
    moduleReexports: POLAR_REEXPORTS,
  };
}

/** polar's `get_client`: three project defs, three different return annotations. */
const clientTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "server/polar/integrations/polar/__init__.py": [],
    "server/polar/integrations/polar/client.py": [{ symbolId: "get_client" }, { symbolId: "PolarSelfClient" }],
    "server/polar/integrations/polar/service.py": [{ symbolId: "PolarService" }],
    "server/polar/checkout/__init__.py": [],
    "server/polar/checkout/ip_geolocation.py": [{ symbolId: "get_client" }, { symbolId: "IPGeolocationClient" }],
    "server/polar/integrations/github/__init__.py": [],
    "server/polar/integrations/github/client.py": [{ symbolId: "get_client" }],
  });

function clientCtx(callerFile: string, imports: readonly ImportRef[]): CallContext {
  return {
    callerFile,
    callerScope: [],
    imports: [...imports],
    symbolTable: clientTable(),
    // Run-global and keyed PER FILE since E5.1c (bd tea-rags-mcp-1v12o.1.7), so
    // only `integrations/polar/client.py`'s `get_client` carries this fact. The
    // bare key this pinned before let one of the three speak for all of them.
    structuredReturnTypes: {
      "server/polar/integrations/polar/client.py::get_client": { form: "instance", name: "PolarSelfClient" },
    },
  };
}

const callBindingType = (callee: string, ctx: CallContext): unknown => {
  const mapper = new PythonImportFileMapper();
  return pythonCallBindingType(callee, 10, ctx, createPythonCallBindingPorts(mapper), mapper);
};

describe("pythonImportBoundFile — the one candidate the caller's binding names", () => {
  const candidates = ["server/polar/models/subscription.py", "server/polar/subscription/schemas.py"];

  it("keeps the candidate the binding maps to through ONE package re-export hop", () => {
    const ctx = polarCtx([
      importOf("polar.models", "Subscription"),
      importOf("polar.subscription.schemas", "SubscriptionChargePreview"),
    ]);
    expect(pythonImportBoundFile("Subscription", candidates, ctx, new PythonImportFileMapper())).toBe(
      "server/polar/models/subscription.py",
    );
  });

  it("keeps the candidate a DIRECT import maps to", () => {
    const ctx = polarCtx([importOf("polar.subscription.schemas", "Subscription")]);
    expect(pythonImportBoundFile("Subscription", candidates, ctx, new PythonImportFileMapper())).toBe(
      "server/polar/subscription/schemas.py",
    );
  });

  it("REFUSES when the caller imports the name from neither candidate", () => {
    const ctx = polarCtx([importOf("sqlalchemy.orm", "Subscription")]);
    expect(pythonImportBoundFile("Subscription", candidates, ctx, new PythonImportFileMapper())).toBeNull();
  });

  it("REFUSES when the caller has no binding for the name and does not declare it", () => {
    const ctx = polarCtx([importOf("polar.subscription.schemas", "SubscriptionChargePreview")]);
    expect(pythonImportBoundFile("Subscription", candidates, ctx, new PythonImportFileMapper())).toBeNull();
  });

  it("falls back to the caller's OWN file when no import bound the name", () => {
    const ctx = polarCtx([]);
    const own = "server/polar/customer_portal/service/subscription.py";
    expect(pythonImportBoundFile("Subscription", [...candidates, own], ctx, new PythonImportFileMapper())).toBe(own);
  });
});

describe("resolveTypeFile — the type-name half", () => {
  it("narrows a namesake the caller's import SET could not, via the binding for that name", () => {
    const ctx = polarCtx([
      importOf("polar.models", "Subscription"),
      importOf("polar.subscription.schemas", "SubscriptionChargePreview"),
    ]);
    expect(resolveTypeFile("Subscription", ctx, new PythonImportFileMapper(), "can_resume")).toBe(
      "server/polar/models/subscription.py",
    );
  });

  it("leaves the import-SET pass answering where no binding names the type", () => {
    // No `Subscription` binding at all: the funnel is silent and the pre-E5.1a
    // set-filter still answers with the one candidate the caller imports FROM.
    const ctx = polarCtx([importOf("polar.subscription.schemas", "SubscriptionChargePreview")]);
    expect(resolveTypeFile("Subscription", ctx, new PythonImportFileMapper(), "can_resume")).toBe(
      "server/polar/subscription/schemas.py",
    );
  });

  it("still REFUSES when neither pass can pin one candidate", () => {
    // Both candidate files are in the import SET and no binding names the type.
    const ctx = polarCtx([
      importOf("polar.subscription.schemas", "SubscriptionChargePreview"),
      importOf("polar.models.subscription", "SubscriptionMeter"),
    ]);
    expect(resolveTypeFile("Subscription", ctx, new PythonImportFileMapper(), "can_resume")).toBeNull();
  });
});

describe("pythonCallBindingType — the call-result half", () => {
  const relative = importOf(".client", "get_client");

  it("reads a namesake callee's return type once the binding pins ONE def", () => {
    const ctx = clientCtx("server/polar/integrations/polar/service.py", [relative]);
    expect(callBindingType("get_client", ctx)).toEqual({ form: "instance", name: "PolarSelfClient" });
  });

  it("REFUSES a fact the narrowed file does not own", () => {
    // `checkout/ip_geolocation.py` declares its own `get_client() ->
    // IPGeolocationClient` and records no fact here; `PolarSelfClient` belongs
    // to `integrations/polar/client.py`. E5.1a checked that by asking whether
    // the narrowed file DECLARED the returned class; the per-file key makes the
    // question unnecessary — the caller simply looks under its own file and
    // finds nothing (bd tea-rags-mcp-1v12o.1.7).
    const ctx = clientCtx("server/polar/checkout/service.py", [
      importOf("polar.checkout.ip_geolocation", "get_client"),
    ]);
    expect(callBindingType("get_client", ctx)).toBeUndefined();
  });

  it("REFUSES when no import bound the callee", () => {
    const ctx = clientCtx("server/polar/integrations/polar/service.py", []);
    expect(callBindingType("get_client", ctx)).toBeUndefined();
  });

  it("keeps the single-def path byte-identical", () => {
    const ctx: CallContext = {
      callerFile: "server/polar/integrations/polar/service.py",
      callerScope: [],
      imports: [],
      symbolTable: tableWith({
        "server/polar/integrations/polar/client.py": [{ symbolId: "build_client" }],
        "server/polar/integrations/polar/service.py": [{ symbolId: "PolarService" }],
      }),
      structuredReturnTypes: {
        "server/polar/integrations/polar/client.py::build_client": { form: "instance", name: "PolarSelfClient" },
      },
    };
    expect(callBindingType("build_client", ctx)).toEqual({ form: "instance", name: "PolarSelfClient" });
  });
});
