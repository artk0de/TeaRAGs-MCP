import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — package-qualified calls under a Go MODULE path. gin's
 * `bytesconv.StringToBytes(s)` imports `github.com/gin-gonic/gin/internal/bytesconv`;
 * the old match asked whether a candidate's relPath CONTAINED the whole import
 * text, which a module-path import never satisfies, so every intra-module
 * package call of every modern Go project went unresolved. The same substring
 * test also over-matched: `foo/bar` accepted `foo/barista/` and `foo/bar/sub/`.
 * A Go package is exactly one directory.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 3,
});

describe("Go importMatch under go.mod module paths", () => {
  let root: string;
  let table: InMemoryGlobalSymbolTable;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-go-import-"));
    writeFileSync(join(root, "go.mod"), "module github.com/gin-gonic/gin\n\ngo 1.26.0\n", "utf8");
    table = new InMemoryGlobalSymbolTable();
    table.upsertFile("internal/bytesconv/bytesconv.go", [sym("StringToBytes", "internal/bytesconv/bytesconv.go")]);
    table.upsertFile("encoding/json/json.go", [sym("Marshal", "encoding/json/json.go")]);
    table.upsertFile("binding/binding.go", [sym("Default", "binding/binding.go")]);
    table.upsertFile("binding/json/json.go", [sym("Default", "binding/json/json.go")]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ctx(importText: string, over: Partial<CallContext> = {}): CallContext {
    return {
      callerFile: "context.go",
      callerScope: [],
      imports: [{ importText, startLine: 1 }],
      symbolTable: table,
      projectRoot: root,
      ...over,
    };
  }

  it("resolves `bytesconv.StringToBytes` through the module path (gin auth.go)", () => {
    const go = new GoLanguage();
    expect(
      go.resolver.resolve(call("bytesconv", "StringToBytes"), ctx("github.com/gin-gonic/gin/internal/bytesconv")),
    ).toEqual({ targetRelPath: "internal/bytesconv/bytesconv.go", targetSymbolId: "StringToBytes" });
  });

  it("reads the module map at pass start, before any call site names the root", () => {
    const go = new GoLanguage();
    go.resolver.prepareResolvePass?.({ expectedFileCount: 1, projectRoot: root });
    expect(
      go.resolver.resolve(call("bytesconv", "StringToBytes"), ctx("github.com/gin-gonic/gin/internal/bytesconv"))
        ?.targetSymbolId,
    ).toBe("StringToBytes");
  });

  it("resolves only in the package's OWN directory, never a sub-package", () => {
    const go = new GoLanguage();
    expect(go.resolver.resolve(call("binding", "Default"), ctx("github.com/gin-gonic/gin/binding"))).toEqual({
      targetRelPath: "binding/binding.go",
      targetSymbolId: "Default",
    });
  });

  it("NEGATIVE: a standard-library import never maps onto a same-named project directory", () => {
    const go = new GoLanguage();
    expect(go.resolver.resolve(call("json", "Marshal"), ctx("encoding/json"))).toBeNull();
  });

  it("NEGATIVE: a method of the same name in the package is not a package-level function", () => {
    table.upsertFile("internal/bytesconv/bytesconv.go", [
      sym("Converter#StringToBytes", "internal/bytesconv/bytesconv.go"),
    ]);
    const go = new GoLanguage();
    expect(
      go.resolver.resolve(call("bytesconv", "StringToBytes"), ctx("github.com/gin-gonic/gin/internal/bytesconv")),
    ).toBeNull();
  });
});

describe("Go importMatch without a go.mod (GOPATH-style fixtures)", () => {
  function ctx(importText: string, table: InMemoryGlobalSymbolTable): CallContext {
    return { callerFile: "main.go", callerScope: [], imports: [{ importText, startLine: 1 }], symbolTable: table };
  }

  it("matches the import path as the package's exact directory", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo/bar/x.go", [sym("Func", "foo/bar/x.go")]);
    expect(new GoLanguage().resolver.resolve(call("bar", "Func"), ctx("foo/bar", table))?.targetRelPath).toBe(
      "foo/bar/x.go",
    );
  });

  it("NEGATIVE: `foo/bar` does not match the prefix namesake `foo/barista/`", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo/barista/x.go", [sym("Func", "foo/barista/x.go")]);
    expect(new GoLanguage().resolver.resolve(call("bar", "Func"), ctx("foo/bar", table))).toBeNull();
  });

  it("NEGATIVE: `foo/bar` does not match its sub-package `foo/bar/sub/`", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo/bar/sub/y.go", [sym("Func", "foo/bar/sub/y.go")]);
    expect(new GoLanguage().resolver.resolve(call("bar", "Func"), ctx("foo/bar", table))).toBeNull();
  });
});

describe("Go importMatch across a multi-module repository", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-go-multimod-"));
    writeFileSync(join(root, "go.mod"), "module example.com/app\n", "utf8");
    mkdirSync(join(root, "tools", "lint"), { recursive: true });
    writeFileSync(join(root, "tools", "lint", "go.mod"), "module example.com/lint\n", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps an import of the nested module to that module's own directory tree", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("tools/lint/rules/rules.go", [sym("Check", "tools/lint/rules/rules.go")]);
    const target = new GoLanguage().resolver.resolve(call("rules", "Check"), {
      callerFile: "cmd/main.go",
      callerScope: [],
      imports: [{ importText: "example.com/lint/rules", startLine: 1 }],
      symbolTable: table,
      projectRoot: root,
    });
    expect(target?.targetRelPath).toBe("tools/lint/rules/rules.go");
  });
});
