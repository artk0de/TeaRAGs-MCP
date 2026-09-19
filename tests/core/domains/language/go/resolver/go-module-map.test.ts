import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseGoModulePath } from "../../../../../../src/core/domains/language/go/manifest.js";
import {
  GoModuleMap,
  GoModuleMapCache,
} from "../../../../../../src/core/domains/language/go/resolver/go-module-map.js";

/**
 * bd tea-rags-mcp-e6xx — Go imports name MODULE paths
 * (`github.com/gin-gonic/gin/internal/bytesconv`), while the index knows
 * repo-relative files (`internal/bytesconv/bytesconv.go`). `go.mod`'s `module`
 * line is the one fact that joins the two: an import `<module>/<subpath>` is
 * the package in directory `<subpath>` under that go.mod — and an import under
 * no module of the repository (the standard library, a dependency) is not a
 * project package at all, whatever directory happens to share its name.
 */
describe("parseGoModulePath", () => {
  it("reads the module directive", () => {
    expect(parseGoModulePath("module github.com/gin-gonic/gin\n\ngo 1.26.0\n")).toBe("github.com/gin-gonic/gin");
  });

  it("accepts a quoted path and a trailing comment, after leading comments", () => {
    expect(parseGoModulePath('// Copyright\n\nmodule "example.com/app" // the app\n')).toBe("example.com/app");
  });

  it("answers undefined for a file with no module directive", () => {
    expect(parseGoModulePath("go 1.22\nrequire example.com/x v1.0.0\n")).toBeUndefined();
  });
});

describe("GoModuleMap#packageDirOf", () => {
  const gin = GoModuleMap.fromManifests([{ relDir: "", content: "module github.com/gin-gonic/gin\n" }]);

  it("maps `<module>/<subpath>` to the directory `<subpath>`", () => {
    expect(gin.packageDirOf("github.com/gin-gonic/gin/internal/bytesconv")).toBe("internal/bytesconv");
  });

  it("maps the module path itself to the module's own directory", () => {
    expect(gin.packageDirOf("github.com/gin-gonic/gin")).toBe("");
  });

  it("maps nothing outside the module — the standard library, a dependency, a prefix namesake", () => {
    expect(gin.packageDirOf("encoding/json")).toBeUndefined();
    expect(gin.packageDirOf("github.com/gin-contrib/sse")).toBeUndefined();
    expect(gin.packageDirOf("github.com/gin-gonic/ginx/render")).toBeUndefined();
  });

  it("resolves inside a NESTED module by its own go.mod, the longest module path winning", () => {
    const repo = GoModuleMap.fromManifests([
      { relDir: "", content: "module example.com/app\n" },
      { relDir: "tools/lint", content: "module example.com/app/tools/lint\n" },
      { relDir: "plugins/x", content: "module other.org/x\n" },
    ]);
    expect(repo.packageDirOf("example.com/app/tools/lint/rules")).toBe("tools/lint/rules");
    expect(repo.packageDirOf("example.com/app/tools")).toBe("tools");
    expect(repo.packageDirOf("other.org/x/y")).toBe("plugins/x/y");
  });

  it("reports whether any module was declared at all", () => {
    expect(gin.declaresModules).toBe(true);
    expect(GoModuleMap.fromManifests([{ relDir: "", content: "go 1.22\n" }]).declaresModules).toBe(false);
  });
});

describe("GoModuleMapCache", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-gomod-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, body: string): void {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }

  it("answers undefined without a project root — nothing to read", () => {
    expect(new GoModuleMapCache().forRoot(undefined)).toBeUndefined();
  });

  it("reads every go.mod under the root once and keeps the map while the root holds", () => {
    write("go.mod", "module example.com/app\n");
    write(join("sub", "go.mod"), "module example.com/app/sub\n");
    const cache = new GoModuleMapCache();
    const first = cache.forRoot(root);
    expect(first?.packageDirOf("example.com/app/sub/pkg")).toBe("sub/pkg");
    expect(cache.forRoot(root)).toBe(first);
  });

  it("never takes a vendored dependency's go.mod for a project module", () => {
    // `go mod vendor` under a go directive below 1.17 copies each dependency's
    // go.mod into vendor/; reading one would make a dependency a project module.
    write("go.mod", "module example.com/app\n");
    write(join("vendor", "github.com", "dep", "go.mod"), "module github.com/dep\n");
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageDirOf("github.com/dep/x")).toBeUndefined();
    expect(map?.packageDirOf("example.com/app/x")).toBe("x");
  });

  it("re-reads on reload, so a new pass sees an edited go.mod", () => {
    write("go.mod", "module example.com/old\n");
    const cache = new GoModuleMapCache();
    expect(cache.forRoot(root)?.packageDirOf("example.com/old/a")).toBe("a");
    write("go.mod", "module example.com/new\n");
    cache.reload(root);
    expect(cache.forRoot(root)?.packageDirOf("example.com/new/a")).toBe("a");
    expect(cache.forRoot(root)?.packageDirOf("example.com/old/a")).toBeUndefined();
  });

  /**
   * G2-1 — a project package's name is its own `package` clause, which the
   * importing file never spells: `api/v1` may declare `package v1`,
   * `internal/json-iter` `package jsoniter`.
   */
  it("reads a project package's name off its own `package` clause", () => {
    write("go.mod", "module example.com/app\n");
    write(join("api", "v1", "types.go"), "// Package v1 is the v1 API.\npackage v1\n");
    write(join("internal", "json-iter", "iter.go"), "package jsoniter\n");
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageNameOf("api/v1")).toBe("v1");
    expect(map?.packageNameOf("internal/json-iter")).toBe("jsoniter");
  });

  it("reads past `_test.go` files and `package main` generators; a directory with neither declares nothing", () => {
    write("go.mod", "module example.com/app\n");
    write(join("widget", "a_test.go"), "package widget_test\n");
    write(join("widget", "gen.go"), "//go:build ignore\n\npackage main\n");
    write(join("widget", "widget.go"), "package widget\n");
    write(join("tests", "x_test.go"), "package tests\n");
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageNameOf("widget")).toBe("widget");
    expect(map?.packageNameOf("tests")).toBeUndefined();
    expect(map?.packageNameOf("missing")).toBeUndefined();
  });

  /**
   * F3-4 — a file whose build constraint excludes it from the default build
   * (`//go:build ignore`, a generator or a tool) may declare any package; one
   * sorted ahead of the package's real files named the package for the whole
   * directory (f3c `lib/a_tools.go` `package tools` beside `lib/lib.go`).
   */
  it("prefers the clause of files without a build constraint", () => {
    write("go.mod", "module example.com/app\n");
    write(join("lib", "a_tools.go"), "//go:build ignore\n\npackage tools\n\nfunc Gen() {}\n");
    write(join("lib", "lib.go"), "package lib\n");
    write(join("legacy", "a_gen.go"), "// Copyright\n\n// +build ignore\n\npackage gen\n");
    write(join("legacy", "legacy.go"), "package legacy\n");
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageNameOf("lib")).toBe("lib");
    expect(map?.packageNameOf("legacy")).toBe("legacy");
  });

  it("reads a package whose every file is constrained off those files", () => {
    write("go.mod", "module example.com/app\n");
    write(join("osx", "open_linux.go"), "//go:build linux\n\npackage osx\n");
    write(join("osx", "open_windows.go"), "//go:build windows\n\npackage osx\n");
    expect(new GoModuleMapCache().forRoot(root)?.packageNameOf("osx")).toBe("osx");
  });

  it("NEGATIVE: files that still disagree on the clause leave it unread", () => {
    write("go.mod", "module example.com/app\n");
    write(join("mixed", "a.go"), "package alpha\n");
    write(join("mixed", "b.go"), "package beta\n");
    write(join("gated", "a.go"), "//go:build tools\n\npackage tools\n");
    write(join("gated", "b.go"), "//go:build !tools\n\npackage gated\n");
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageNameOf("mixed")).toBeUndefined();
    expect(map?.packageNameOf("gated")).toBeUndefined();
  });

  /**
   * F4 / N1 — the clause is a file's first token past its comments. A doc.go
   * block comment whose prose starts a line with "package" is no clause: read
   * as one (`package being`), it disagreed with the package's real files and
   * left the clause unread (the re-validator's `f4c/lib5`: dir `lib5`, package
   * `eps`, so `eps.New()` bound nothing).
   */
  it("reads the clause past a block comment whose prose starts a line with `package`", () => {
    write("go.mod", "module example.com/app\n");
    const doc = (name: string) =>
      `/*\nPackage ${name} drives an analysis over the\npackage being analyzed, and reports what it finds.\n*/\npackage ${name}\n`;
    write(join("lib5", "api.go"), "package eps\n\nfunc New() {}\n");
    write(join("lib5", "doc.go"), doc("eps"));
    write(join("zeta", "doc.go"), doc("zeta"));
    write(join("zeta", "zeta.go"), "package zeta\n");
    write(
      join("lines", "doc.go"),
      "// Package lines is documented by line comments.\n//\n// package lines is not a clause here.\npackage lines\n",
    );
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageNameOf("lib5")).toBe("eps");
    expect(map?.packageNameOf("zeta")).toBe("zeta");
    expect(map?.packageNameOf("lines")).toBe("lines");
  });

  /**
   * The header a build constraint sits in is the comments BEFORE the clause,
   * and only its `//` lines: a `//go:build` spelled inside a block comment
   * constrains nothing, so `open/a.go` answers beside a truly ignored file.
   */
  it("reads a build constraint only off the `//` lines of the header", () => {
    write("go.mod", "module example.com/app\n");
    write(join("open", "a.go"), "/*\n//go:build ignore\n*/\npackage open\n");
    write(join("open", "b_gen.go"), "//go:build ignore\n\npackage gen\n");
    write(join("spaced", "a.go"), "\t//go:build ignore\n\npackage gen\n");
    write(join("spaced", "b.go"), "package spaced\n");
    const map = new GoModuleMapCache().forRoot(root);
    expect(map?.packageNameOf("open")).toBe("open");
    expect(map?.packageNameOf("spaced")).toBe("spaced");
  });

  it("NEGATIVE: a file whose first token is no `package` clause declares nothing", () => {
    write("go.mod", "module example.com/app\n");
    write(join("broken", "a.go"), "/* unterminated\npackage broken\n");
    write(join("broken", "b.go"), "func x() {}\npackage broken\n");
    expect(new GoModuleMapCache().forRoot(root)?.packageNameOf("broken")).toBeUndefined();
  });

  it("knows no package name without a root to read from", () => {
    expect(GoModuleMap.fromManifests([{ relDir: "", content: "module example.com/app\n" }]).packageNameOf("")).toBe(
      undefined,
    );
  });
});
