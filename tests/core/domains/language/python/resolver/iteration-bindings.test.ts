/**
 * P1 iteration bindings, resolver half (bd tea-rags-mcp-m99j1.1.18).
 *
 * The walker records a loop / comprehension target as an `iterationElement`
 * binding carrying the ITERATED expression. The resolver folds that expression
 * to a container type through the facts the run already carries, then reads
 * the element through the built-in container table or a project class's own
 * `__iter__` → `__next__`. No container fact ⇒ no type: the binding never
 * invents one, and it never lets a stale binding from above the loop speak for
 * the loop variable.
 */
import { describe, expect, it } from "vitest";

import {
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type LocalBinding,
  type SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonExternalVocabulary } from "../../../../../../src/core/domains/language/python/resolver/python-external-vocabulary.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { createPythonReceiverTypePorts } from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return table;
}

const instance = (name: string): TypeRef => ({ form: "instance", name });
const containerOf = (name: string): TypeRef => ({ form: "container", element: instance(name) });

const iterationOf = (line: number, sourceExpression: string, tupleIndex?: number): LocalBinding => ({
  line,
  type: "",
  valueKind: "iterationElement",
  sourceExpression,
  ...(tupleIndex === undefined ? {} : { tupleIndex }),
  endLine: line,
});

const call = (receiver: string, member: string, startLine: number): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const resolve = (ref: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
  new PythonCallResolver().resolve(ref, ctx);

const APPS_FILE = "apps/registry.py";
const APPS_TABLE = {
  [APPS_FILE]: ["Apps", "Apps#get_models", "AppConfig", "AppConfig#get_models"],
};

describe("Python iteration bindings — the element type of a loop target", () => {
  it("`for app_config in self.app_configs.values()` over `dict[str, AppConfig]` → AppConfig#get_models", () => {
    const ctx: CallContext = {
      callerFile: APPS_FILE,
      callerScope: ["Apps", "get_models"],
      imports: [],
      symbolTable: tableWith(APPS_TABLE),
      localBindings: { app_config: [iterationOf(10, "self.app_configs.values()")] },
      // `self.app_configs` read as a member yields `dict[str, AppConfig]`,
      // which the annotation parser renders as the mapping's VALUE container.
      structuredReturnTypes: { "Apps#app_configs": containerOf("AppConfig") },
    };
    expect(resolve(call("app_config", "get_models", 11), ctx)?.targetSymbolId).toBe("AppConfig#get_models");
  });

  it("a walker-typed binding on the loop's own line outranks the unfolded iteration binding", () => {
    // The same-file annotation pass types the loop variable at extraction
    // time; the merge puts the walker's iteration site first on that line.
    const ctx: CallContext = {
      callerFile: APPS_FILE,
      callerScope: ["Apps", "get_models"],
      imports: [],
      symbolTable: tableWith(APPS_TABLE),
      localBindings: {
        app_config: [iterationOf(10, "self.app_configs.values()"), { line: 10, type: "AppConfig" }],
      },
    };
    expect(resolve(call("app_config", "get_models", 11), ctx)?.targetSymbolId).toBe("AppConfig#get_models");
  });

  it("`for i, op in enumerate(ops)` with `ops: list[Operation]` → Operation#reduce", () => {
    const ctx: CallContext = {
      callerFile: "migrations/optimizer.py",
      callerScope: ["Optimizer", "optimize_inner"],
      imports: [],
      symbolTable: tableWith({
        "migrations/optimizer.py": ["Optimizer", "Optimizer#optimize_inner", "Operation", "Operation#reduce"],
      }),
      localBindings: {
        ops: [{ line: 5, type: "Operation", typeRef: containerOf("Operation") }],
        op: [iterationOf(6, "enumerate(ops)", 1)],
        i: [iterationOf(6, "enumerate(ops)", 0)],
      },
    };
    expect(resolve(call("op", "reduce", 7), ctx)?.targetSymbolId).toBe("Operation#reduce");
  });

  it("a project class iterates through its own `__iter__` → `__next__`", () => {
    const ctx: CallContext = {
      callerFile: "bags.py",
      callerScope: ["Shop", "run"],
      imports: [],
      symbolTable: tableWith({
        "bags.py": [
          "Shop",
          "Shop#run",
          "Bag",
          "Bag#__iter__",
          "BagIterator",
          "BagIterator#__next__",
          "Item",
          "Item#price",
        ],
      }),
      localBindings: {
        bag: [{ line: 3, type: "Bag" }],
        item: [iterationOf(4, "bag")],
      },
      structuredReturnTypes: {
        "Bag#__iter__": instance("BagIterator"),
        "BagIterator#__next__": instance("Item"),
      },
    };
    expect(resolve(call("item", "price", 5), ctx)?.targetSymbolId).toBe("Item#price");
  });

  it("no container fact ⇒ no type, and the binding above the loop no longer speaks for it", () => {
    const ctx: CallContext = {
      callerFile: "widgets.py",
      callerScope: ["Panel", "run"],
      imports: [],
      symbolTable: tableWith({
        "widgets.py": ["Panel", "Panel#run", "Widget", "Widget#close", "Window", "Window#close"],
      }),
      localBindings: {
        // `w = Widget()` above, then `for w in things:` rebinds it.
        w: [{ line: 3, type: "Widget" }, iterationOf(4, "things")],
      },
    };
    expect(resolve(call("w", "close", 5), ctx)?.targetSymbolId).not.toBe("Widget#close");
  });

  it("an iteration binding no fact types leaves the naming-convention guess standing", () => {
    // django/apps/registry.py: `for app_config in self.app_configs.values():`
    // over an UNANNOTATED dict — the convention read is the only evidence.
    const ctx: CallContext = {
      callerFile: APPS_FILE,
      callerScope: ["Apps", "populate"],
      imports: [],
      symbolTable: tableWith({ [APPS_FILE]: ["Apps", "Apps#populate", "AppConfig", "AppConfig#import_models"] }),
      classAncestors: {},
      localBindings: { app_config: [iterationOf(10, "self.app_configs.values()")] },
    };
    expect(resolve(call("app_config", "import_models", 11), ctx)?.targetSymbolId).toBe("AppConfig#import_models");
  });

  it("an unfolded loop target stays untyped for the coreAmbiguous bucket; a folded one is typed", () => {
    // django/template/loader.py: `for engine in engines:` over an unannotated
    // list — a `get_template` on it must stay in the coreAmbiguous bucket.
    const vocabulary = new PythonExternalVocabulary(new PythonImportFileMapper());
    const ctx: CallContext = {
      callerFile: "migrations/optimizer.py",
      callerScope: ["Optimizer", "optimize_inner"],
      imports: [],
      symbolTable: tableWith({ "migrations/optimizer.py": ["Optimizer", "Operation", "Operation#reduce"] }),
      localBindings: {
        engine: [iterationOf(6, "engines")],
        ops: [{ line: 5, type: "Operation", typeRef: containerOf("Operation") }],
        op: [iterationOf(6, "ops")],
      },
    };
    expect(vocabulary.isReceiverTyped("engine", ctx, 7)).toBe(false);
    expect(vocabulary.isReceiverTyped("op", ctx, 7)).toBe(true);
  });

  it("the shared lookup prefers the typed binding over the iteration site on the same line", () => {
    // The cone and every other raw reader see the walker-typed loop target.
    const bindings = { tag: [iterationOf(290, "self.order"), { line: 290, type: "JSONTag" }] };
    expect(resolveLocalBindingType(bindings, "tag", 292)).toBe("JSONTag");
  });

  it("the kernel `elementTypeOf` port reads a container's element and declines a bare nominal", () => {
    const ports = createPythonReceiverTypePorts(new PythonImportFileMapper());
    const ctx: CallContext = {
      callerFile: APPS_FILE,
      callerScope: ["Apps", "get_models"],
      imports: [],
      symbolTable: tableWith(APPS_TABLE),
    };
    expect(ports.elementTypeOf?.(containerOf("AppConfig"), ctx)).toEqual(instance("AppConfig"));
    expect(ports.elementTypeOf?.(instance("AppConfig"), ctx)).toBeNull();
  });
});
