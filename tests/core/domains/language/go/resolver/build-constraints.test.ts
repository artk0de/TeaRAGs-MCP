import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  goBuildContextForHost,
  goFileBuildsByDefault,
} from "../../../../../../src/core/domains/language/go/resolver/go-build-constraints.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { extractFromGoFile } from "../../../../../../src/core/domains/language/go/walker/walker.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * Build-tag twins: gin declares `validate` twice in package `binding` —
 * `binding.go` under `//go:build !nomsgpack`, `binding_nomsgpack.go` under
 * `//go:build nomsgpack`. Exactly one compiles in any build, so the pair is no
 * ambiguity to the compiler, and the default build (no custom tags) compiles
 * `binding.go`. The walker records each file's `//go:build` expression; the
 * resolver prefers, among same-package candidates that ALL carry a build
 * constraint, the one file whose constraint holds under the default tag set.
 */

const LINUX_AMD64 = goBuildContextForHost("linux", "x64");
const DARWIN_ARM64 = goBuildContextForHost("darwin", "arm64");

describe("goFileBuildsByDefault — a file's constraint under the default tag set", () => {
  it("evaluates `//go:build` expressions: custom tags are unset, the host's GOOS/GOARCH are set", () => {
    expect(goFileBuildsByDefault("binding/binding.go", "!nomsgpack", LINUX_AMD64)).toBe(true);
    expect(goFileBuildsByDefault("binding/binding_nomsgpack.go", "nomsgpack", LINUX_AMD64)).toBe(false);
    expect(goFileBuildsByDefault("a.go", "linux && (amd64 || arm64)", LINUX_AMD64)).toBe(true);
    expect(goFileBuildsByDefault("a.go", "linux && (amd64 || arm64)", DARWIN_ARM64)).toBe(false);
    expect(goFileBuildsByDefault("a.go", "unix && !windows", DARWIN_ARM64)).toBe(true);
    expect(goFileBuildsByDefault("a.go", "go1.21 && gc", LINUX_AMD64)).toBe(true);
  });

  it("reads the GOOS / GOARCH a file name implies, alone or with an expression", () => {
    expect(goFileBuildsByDefault("sys/open_linux.go", undefined, LINUX_AMD64)).toBe(true);
    expect(goFileBuildsByDefault("sys/open_windows.go", undefined, LINUX_AMD64)).toBe(false);
    expect(goFileBuildsByDefault("sys/open_darwin_arm64.go", undefined, DARWIN_ARM64)).toBe(true);
    expect(goFileBuildsByDefault("sys/open_darwin_amd64_test.go", undefined, DARWIN_ARM64)).toBe(false);
    expect(goFileBuildsByDefault("sys/open_linux.go", "cgo", LINUX_AMD64)).toBe(true);
  });

  it("answers undefined for a file that carries no constraint at all, or one it cannot parse", () => {
    expect(goFileBuildsByDefault("binding/binding.go", undefined, LINUX_AMD64)).toBeUndefined();
    expect(goFileBuildsByDefault("linux.go", undefined, LINUX_AMD64)).toBeUndefined();
    expect(goFileBuildsByDefault("a.go", "linux &&", LINUX_AMD64)).toBeUndefined();
  });
});

describe("Go walker — the file's build constraint", () => {
  function walk(lines: string[]) {
    const src = `${lines.join("\n")}\n`;
    const parser = new Parser();
    parser.setLanguage(GoLang);
    return extractFromGoFile({ tree: parser.parse(src), code: src, relPath: "b.go", language: "go", chunks: [] });
  }

  it("records the `//go:build` expression that precedes the package clause", () => {
    expect(walk(["// Copyright", "", "//go:build !nomsgpack", "", "package binding"]).buildConstraint).toBe(
      "!nomsgpack",
    );
  });

  it("records nothing for a file without one, or for a `//go:build` after the package clause", () => {
    expect(walk(["package binding"]).buildConstraint).toBeUndefined();
    expect(walk(["package binding", "", "//go:build nomsgpack"]).buildConstraint).toBeUndefined();
  });
});

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function twinsTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("binding/binding.go", [sym("validate", "binding/binding.go")]);
  t.upsertFile("binding/binding_nomsgpack.go", [sym("validate", "binding/binding_nomsgpack.go")]);
  return t;
}

const bare: CallRef = { callText: "validate(obj)", receiver: null, member: "validate", startLine: 5 };

function bindingCtx(over: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "binding/json.go",
    callerScope: [],
    imports: [],
    symbolTable: twinsTable(),
    buildConstraintsByFile: {
      "binding/binding.go": "!nomsgpack",
      "binding/binding_nomsgpack.go": "nomsgpack",
    },
    ...over,
  };
}

const resolver = new GoCallResolver(new DefaultSymbolIdComposer());

describe("GoCallResolver — build-tag twins", () => {
  it("resolves a bare call to the twin the default build compiles (gin's `validate`)", () => {
    expect(resolver.resolve(bare, bindingCtx())).toEqual({
      targetRelPath: "binding/binding.go",
      targetSymbolId: "validate",
    });
  });

  it("resolves a package-qualified call to the default-build twin", () => {
    const call: CallRef = { callText: "binding.validate(o)", receiver: "binding", member: "validate", startLine: 5 };
    const ctx = bindingCtx({ callerFile: "gin.go", imports: [{ importText: "binding", startLine: 1 }] });
    expect(resolver.resolve(call, ctx)?.targetRelPath).toBe("binding/binding.go");
  });

  it("NEGATIVE: stays ambiguous when a twin's constraint is unknown (not walked this run)", () => {
    const ctx = bindingCtx({ buildConstraintsByFile: { "binding/binding.go": "!nomsgpack" } });
    expect(resolver.resolve(bare, ctx)).toBeNull();
  });

  it("NEGATIVE: stays ambiguous when both twins build by default", () => {
    const ctx = bindingCtx({
      buildConstraintsByFile: { "binding/binding.go": "!nomsgpack", "binding/binding_nomsgpack.go": "!other" },
    });
    expect(resolver.resolve(bare, ctx)).toBeNull();
  });
});
