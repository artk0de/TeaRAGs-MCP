import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — a bare `foo()` in Go names a declaration of the
 * caller's OWN package (one directory), a dot-imported package's, or a builtin
 * — never another package's. The global short-name fallback searched the whole
 * table, so a namesake anywhere either fabricated an edge or made the call
 * ambiguous; gin's `WriteString(w, r.Format, r.Data)` in render/text.go was
 * lost to `responseWriter#WriteString`, a METHOD in the root package.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

const bare = (member: string): CallRef => ({ callText: `${member}()`, receiver: null, member, startLine: 5 });

function table(...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
}

function ctx(callerFile: string, symbolTable: InMemoryGlobalSymbolTable, imports: ImportRef[] = []): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable };
}

const resolver = new GoCallResolver(new DefaultSymbolIdComposer());

describe("Go bare calls resolve in the caller's package", () => {
  it("resolves gin's `WriteString(...)` in render/text.go past a same-named METHOD elsewhere", () => {
    const t = table(
      ["render/text.go", [sym("WriteString", "render/text.go")]],
      ["response_writer.go", [sym("responseWriter#WriteString", "response_writer.go")]],
    );
    expect(resolver.resolve(bare("WriteString"), ctx("render/text.go", t))).toEqual({
      targetRelPath: "render/text.go",
      targetSymbolId: "WriteString",
    });
  });

  it("a namesake in ANOTHER package does not make a same-package call ambiguous", () => {
    const t = table(["a/helper.go", [sym("helper", "a/helper.go")]], ["b/helper.go", [sym("helper", "b/helper.go")]]);
    expect(resolver.resolve(bare("helper"), ctx("a/main.go", t))?.targetRelPath).toBe("a/helper.go");
  });

  it("NEGATIVE: a same-package METHOD is never the target of a bare call (gin recovery.go `handle(c, rec)`)", () => {
    // `handle` there is a func-typed parameter; the whole-table search pinned
    // it on `RouterGroup#handle`, which Go cannot call without a receiver.
    const t = table(["routergroup.go", [sym("RouterGroup#handle", "routergroup.go")]]);
    expect(resolver.resolve(bare("handle"), ctx("recovery.go", t))).toBeNull();
  });

  it("NEGATIVE: a declaration only in another package does not resolve", () => {
    const t = table(["b/helper.go", [sym("helper", "b/helper.go")]]);
    expect(resolver.resolve(bare("helper"), ctx("a/main.go", t))).toBeNull();
  });

  it("resolves into a DOT-imported package", () => {
    const t = table(["util/strings.go", [sym("Reverse", "util/strings.go")]]);
    const imports: ImportRef[] = [{ importText: "util", startLine: 2, importedNames: ["."] }];
    expect(resolver.resolve(bare("Reverse"), ctx("cmd/main.go", t, imports))?.targetRelPath).toBe("util/strings.go");
  });

  it("NEGATIVE: build-tag twins in the caller's package stay ambiguous (gin's binding `validate`)", () => {
    const t = table(
      ["binding/binding.go", [sym("validate", "binding/binding.go")]],
      ["binding/binding_nomsgpack.go", [sym("validate", "binding/binding_nomsgpack.go")]],
    );
    expect(resolver.resolve(bare("validate"), ctx("binding/form.go", t))).toBeNull();
  });
});

describe("Go package-qualified calls through an import alias", () => {
  const t = table(["foo/bar/x.go", [sym("Func", "foo/bar/x.go")]]);
  const aliased: ImportRef[] = [{ importText: "foo/bar", startLine: 1, importedNames: ["al"] }];
  const call = (receiver: string): CallRef => ({
    callText: `${receiver}.Func()`,
    receiver,
    member: "Func",
    startLine: 4,
  });

  it('resolves `al.Func()` through `import al "foo/bar"`', () => {
    expect(resolver.resolve(call("al"), ctx("main.go", t, aliased))?.targetRelPath).toBe("foo/bar/x.go");
  });

  it("NEGATIVE: the path's last segment is not in scope once the import is aliased", () => {
    expect(resolver.resolve(call("bar"), ctx("main.go", t, aliased))).toBeNull();
  });
});
