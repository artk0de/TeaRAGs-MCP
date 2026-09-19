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
});
