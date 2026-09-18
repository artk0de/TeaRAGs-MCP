import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — a package-qualified generic call, `pkg.Map[int](xs, f)`
 * or `pkg.Pair[int](x)`, reaches the resolver as a BARE call whose member is
 * the whole instantiated name (`pkg.Map[int]`): the grammar parses the callee
 * as an index expression or a conversion to a generic type. With the type
 * arguments stripped it is the call `pkg.Map` — the receiver an imported
 * package, the member a package-level declaration — which the module-path
 * import match answers. Go has no generic methods, so a VALUE on the left
 * (`c.handlers[c.index](c)`) is an index, never an instantiation.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

const bare = (member: string): CallRef => ({ callText: `${member}(x)`, receiver: null, member, startLine: 6 });

describe("Go package-qualified generic calls", () => {
  let root: string;
  let table: InMemoryGlobalSymbolTable;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-go-qualified-generic-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n", "utf8");
    table = new InMemoryGlobalSymbolTable();
    table.upsertFile("internal/slices/map.go", [sym("Map", "internal/slices/map.go")]);
    table.upsertFile("internal/slices/pair.go", [sym("Pair", "internal/slices/pair.go")]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ctx(imports: ImportRef[], over: Partial<CallContext> = {}): CallContext {
    return { callerFile: "cmd/main.go", callerScope: [], imports, symbolTable: table, projectRoot: root, ...over };
  }

  const slicesImport: ImportRef[] = [{ importText: "example.com/app/internal/slices", startLine: 3 }];

  it("resolves `slices.Map[int](xs, f)` through the module-path import", () => {
    expect(new GoLanguage().resolver.resolve(bare("slices.Map[int]"), ctx(slicesImport))).toEqual({
      targetRelPath: "internal/slices/map.go",
      targetSymbolId: "Map",
    });
  });

  it("resolves the single-argument form `slices.Pair[int, string](x)` the same way", () => {
    expect(new GoLanguage().resolver.resolve(bare("slices.Pair[int, string]"), ctx(slicesImport))?.targetSymbolId).toBe(
      "Pair",
    );
  });

  it("honours an import alias", () => {
    const aliased: ImportRef[] = [{ ...slicesImport[0], importedNames: ["sl"] }];
    expect(new GoLanguage().resolver.resolve(bare("sl.Map[int]"), ctx(aliased))?.targetSymbolId).toBe("Map");
  });

  it("NEGATIVE: a qualifier that names no import is not a package (`c.handlers[c.index](c)`)", () => {
    expect(new GoLanguage().resolver.resolve(bare("c.handlers[c.index]"), ctx(slicesImport))).toBeNull();
  });

  it("NEGATIVE: a local named like the package shadows it", () => {
    const shadowed = ctx(slicesImport, { localBindings: { slices: [{ line: 2, type: "Registry" }] } });
    expect(new GoLanguage().resolver.resolve(bare("slices.Map[int]"), shadowed)).toBeNull();
  });

  it("NEGATIVE: a standard-library package never lands on a same-named project directory", () => {
    const stdlib: ImportRef[] = [{ importText: "slices", startLine: 3 }];
    table.upsertFile("slices/slices.go", [sym("Map", "slices/slices.go")]);
    expect(new GoLanguage().resolver.resolve(bare("slices.Map[int]"), ctx(stdlib))).toBeNull();
  });
});
