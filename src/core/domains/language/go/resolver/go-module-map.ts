/**
 * Go import path → project package directory (bd tea-rags-mcp-e6xx).
 *
 * A Go import names a package by MODULE path
 * (`github.com/gin-gonic/gin/internal/bytesconv`); the index knows
 * repo-relative files (`internal/bytesconv/bytesconv.go`). A `go.mod`'s
 * `module` line joins the two: an import `<module>/<subpath>` is the package in
 * directory `<subpath>` beneath that go.mod. A multi-module repository declares
 * one module per nested go.mod, and the LONGEST module path that prefixes an
 * import owns it — `example.com/app/tools/lint/rules` belongs to a nested
 * `example.com/app/tools/lint`, not to the root `example.com/app`.
 *
 * An import no module of the repository prefixes is not a project package: the
 * standard library (`encoding/json`) and every dependency map to nothing, so a
 * project directory that merely shares their name is never picked.
 */

import { readManifestFiles } from "../../../../infra/dependency-manifests.js";
import { GO_MODULE_MANIFEST_FILE, parseGoModulePath } from "../manifest.js";

interface GoModuleRoot {
  readonly modulePath: string;
  /** Repo-relative directory of the go.mod, `""` for the root. */
  readonly dir: string;
}

export class GoModuleMap {
  /** Longest module path first, so the first prefix hit is the owning module. */
  private readonly roots: readonly GoModuleRoot[];

  private constructor(roots: GoModuleRoot[]) {
    this.roots = roots.sort((a, b) => b.modulePath.length - a.modulePath.length);
  }

  /** Build from the manifests a walk found; a go.mod without a `module` line declares nothing. */
  static fromManifests(files: readonly { relDir: string; content: string }[]): GoModuleMap {
    const roots: GoModuleRoot[] = [];
    for (const file of files) {
      const modulePath = parseGoModulePath(file.content);
      if (modulePath !== undefined) roots.push({ modulePath, dir: file.relDir });
    }
    return new GoModuleMap(roots);
  }

  /** Whether the repository declares any module — without one, import paths are GOPATH-shaped. */
  get declaresModules(): boolean {
    return this.roots.length > 0;
  }

  /** The repo-relative package directory an import names, `undefined` when it is not a project package. */
  packageDirOf(importPath: string): string | undefined {
    for (const root of this.roots) {
      if (importPath !== root.modulePath && !importPath.startsWith(`${root.modulePath}/`)) continue;
      const subpath = importPath.slice(root.modulePath.length + 1);
      if (root.dir === "") return subpath;
      return subpath === "" ? root.dir : `${root.dir}/${subpath}`;
    }
    return undefined;
  }
}

/**
 * The module map of the project a pass resolves, read from disk once per root.
 *
 * Single-entry, like `TypeScriptLanguage`'s bound resolver: one provider serves
 * one indexed project at a time. `reload` is what `prepareResolvePass` calls, so
 * every pass-2 reads the go.mod files as they are NOW — a long-lived process
 * never resolves a new run against a stale module path. Without a root (unit
 * tests, harnesses that pass none) there is nothing to read and the caller
 * falls back to GOPATH-shaped matching.
 */
export class GoModuleMapCache {
  private bound: { root: string; map: GoModuleMap } | undefined;

  forRoot(root: string | undefined): GoModuleMap | undefined {
    if (root === undefined) return undefined;
    if (this.bound?.root !== root) this.reload(root);
    return this.bound?.map;
  }

  reload(root: string | undefined): void {
    if (root === undefined) return;
    const files = readManifestFiles(root, (fileName) => fileName === GO_MODULE_MANIFEST_FILE);
    this.bound = { root, map: GoModuleMap.fromManifests(files) };
  }
}
