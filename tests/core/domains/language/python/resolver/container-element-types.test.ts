/**
 * Container element facts, resolver half (bd tea-rags-mcp-m99j1.1.41).
 *
 * The walker records what an UNANNOTATED container holds as a derived binding
 * on the pseudo-name `<iterable>[]`. The iteration fold reads it only when the
 * container itself carries no type: a typed container outranks the writes, and
 * a write spelling no fact types leaves the loop target untyped.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  LocalBinding,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
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

const derived = (
  valueKind: "iterationElement" | "tupleElement",
  line: number,
  sourceExpression: string,
  tupleIndex?: number,
): LocalBinding => ({
  line,
  type: "",
  valueKind,
  sourceExpression,
  ...(tupleIndex === undefined ? {} : { tupleIndex }),
});

const call = (receiver: string, member: string, startLine: number): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const resolve = (ref: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
  new PythonCallResolver().resolve(ref, ctx);

const FILE = "apps/registry.py";
const TABLE = tableWith({
  [FILE]: ["Apps", "Apps#populate", "AppConfig", "AppConfig#import_models", "Other", "Other#import_models"],
});

const ctxWith = (localBindings: CallContext["localBindings"], extra: Partial<CallContext> = {}): CallContext => ({
  callerFile: FILE,
  callerScope: ["Apps", "populate"],
  imports: [],
  symbolTable: TABLE,
  classAncestors: {},
  localBindings,
  ...extra,
});

describe("Python container element facts — the written value types the loop target", () => {
  it("`.values()` over a mapping field written `AppConfig()` → AppConfig#import_models", () => {
    const ctx = ctxWith({
      "self.app_configs.values()[]": [derived("tupleElement", 4, "AppConfig()")],
      cfg: [derived("iterationElement", 8, "self.app_configs.values()")],
    });
    expect(resolve(call("cfg", "import_models", 9), ctx)?.targetSymbolId).toBe("AppConfig#import_models");
  });

  it("`.items()` reads the written value at position 1, and position 0 stays untyped", () => {
    const ctx = ctxWith({
      "self.app_configs.values()[]": [derived("tupleElement", 4, "AppConfig()")],
      label: [derived("iterationElement", 8, "self.app_configs.items()", 0)],
      cfg: [derived("iterationElement", 8, "self.app_configs.items()", 1)],
    });
    expect(resolve(call("cfg", "import_models", 9), ctx)?.targetSymbolId).toBe("AppConfig#import_models");
    expect(resolve(call("label", "import_models", 9), ctx)?.targetSymbolId).not.toBe("AppConfig#import_models");
  });

  it("a BARE iteration over the mapping never reads the `.values()` fact — it yields keys", () => {
    const ctx = ctxWith({
      "self.app_configs.values()[]": [derived("tupleElement", 4, "Other()")],
      cfg: [derived("iterationElement", 8, "self.app_configs")],
    });
    expect(resolve(call("cfg", "import_models", 9), ctx)?.targetSymbolId).not.toBe("Other#import_models");
  });

  it("a local list read through an element-preserving builtin", () => {
    const ctx = ctxWith({
      "items[]": [derived("tupleElement", 2, "Other()")],
      it: [derived("iterationElement", 5, "sorted(items)")],
    });
    expect(resolve(call("it", "import_models", 6), ctx)?.targetSymbolId).toBe("Other#import_models");
  });

  it("an identity comprehension iterates like its source", () => {
    const ctx = ctxWith({
      metrics: [{ line: 1, type: "AppConfig", typeRef: containerOf("AppConfig") }],
      "active[]": [derived("iterationElement", 2, "metrics")],
      metric: [derived("iterationElement", 5, "active")],
    });
    expect(resolve(call("metric", "import_models", 5), ctx)?.targetSymbolId).toBe("AppConfig#import_models");
  });

  it("a walker-typed CLASS element (polar `list[type[SQLMetric]]` comprehension) resolves the class-level member", () => {
    const ctx = ctxWith({
      "active[]": [{ line: 2, type: "AppConfig", valueKind: "class" }],
      metric: [derived("iterationElement", 5, "active")],
    });
    // `metric` is the CLASS, so a call on it reads `AppConfig.import_models`'s owner as the class form.
    expect(resolve(call("metric", "import_models", 6), ctx)?.targetSymbolId).toBe("AppConfig#import_models");
  });

  it("a typed container outranks the writes", () => {
    const ctx = ctxWith(
      {
        "self.app_configs.values()[]": [derived("tupleElement", 4, "Other()")],
        cfg: [derived("iterationElement", 8, "self.app_configs.values()")],
      },
      { structuredReturnTypes: { "Apps#app_configs": containerOf("AppConfig") } },
    );
    expect(resolve(call("cfg", "import_models", 9), ctx)?.targetSymbolId).toBe("AppConfig#import_models");
  });

  it("a write spelling no fact types leaves the target untyped", () => {
    const ctx = ctxWith({
      "items[]": [derived("tupleElement", 2, "make_thing()")],
      thing: [derived("iterationElement", 5, "items")],
    });
    const target = resolve(call("thing", "import_models", 6), ctx);
    expect(target?.targetSymbolId).not.toBe("AppConfig#import_models");
    expect(target?.targetSymbolId).not.toBe("Other#import_models");
  });

  it("a fact recorded BELOW the loop does not speak for it", () => {
    const ctx = ctxWith({
      "items[]": [derived("tupleElement", 9, "Other()")],
      it: [derived("iterationElement", 5, "items")],
    });
    expect(resolve(call("it", "import_models", 6), ctx)?.targetSymbolId).not.toBe("Other#import_models");
  });
});
