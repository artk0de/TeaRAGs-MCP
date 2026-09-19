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
 *
 * A project package's NAME is its own `package` clause, which the importing
 * file never spells (G2-1): `api/v1` may declare `package v1`,
 * `internal/json-iter` `package jsoniter`. The map reads it off the package's
 * directory on first ask, the way it reads go.mod — per root, re-read every
 * pass — so the qualifier a plain import binds is the one the compiler binds,
 * not only the one Go's tooling would assume from the path.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readManifestFiles } from "../../../../infra/dependency-manifests.js";
import { GO_MODULE_MANIFEST_FILE, GO_MODULE_WALK_IGNORED_DIRS, parseGoModulePath } from "../manifest.js";

interface GoModuleRoot {
  readonly modulePath: string;
  /** Repo-relative directory of the go.mod, `""` for the root. */
  readonly dir: string;
}

/** A `package` clause at the start of a line — the one place a Go file names its package. */
const GO_PACKAGE_CLAUSE = /^package[ \t]+([\p{L}_][\p{L}\p{Nd}_]*)/mu;

/** `package main` is a command, never an importable package. */
const GO_COMMAND_PACKAGE = "main";

/**
 * The name `dir`'s package declares: the `package` clause of its first non-test
 * `.go` file (by name) that declares one, `undefined` when none does. One file
 * answers for the package — the compiler rejects a directory whose files
 * disagree — except for the two that are not the package at all: a `_test.go`
 * file may be the external `<name>_test` package, and a `package main` file is
 * a `//go:build ignore` generator.
 */
function readGoPackageName(dir: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))
      .sort();
  } catch {
    return undefined;
  }
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const name = GO_PACKAGE_CLAUSE.exec(content)?.[1];
    if (name !== undefined && name !== GO_COMMAND_PACKAGE) return name;
  }
  return undefined;
}

export class GoModuleMap {
  /** Longest module path first, so the first prefix hit is the owning module. */
  private readonly roots: readonly GoModuleRoot[];
  /** Repo-relative package directory → its declared name (`undefined`: none), read once per map. */
  private readonly packageNames = new Map<string, string | undefined>();

  private constructor(
    roots: GoModuleRoot[],
    private readonly repoRoot: string | undefined,
  ) {
    this.roots = roots.sort((a, b) => b.modulePath.length - a.modulePath.length);
  }

  /**
   * Build from the manifests a walk found; a go.mod without a `module` line
   * declares nothing. `repoRoot` is where package directories are read from —
   * absent, no package name is known and every reader falls back to the
   * assumed name.
   */
  static fromManifests(files: readonly { relDir: string; content: string }[], repoRoot?: string): GoModuleMap {
    const roots: GoModuleRoot[] = [];
    for (const file of files) {
      const modulePath = parseGoModulePath(file.content);
      if (modulePath !== undefined) roots.push({ modulePath, dir: file.relDir });
    }
    return new GoModuleMap(roots, repoRoot);
  }

  /**
   * The name the package in repo-relative `packageDir` declares in its
   * `package` clause (`readGoPackageName`), `undefined` when the map has no
   * root to read from or the directory declares no importable package.
   */
  packageNameOf(packageDir: string): string | undefined {
    if (this.repoRoot === undefined) return undefined;
    if (!this.packageNames.has(packageDir)) {
      this.packageNames.set(packageDir, readGoPackageName(join(this.repoRoot, packageDir)));
    }
    return this.packageNames.get(packageDir);
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
    const files = readManifestFiles(
      root,
      (fileName) => fileName === GO_MODULE_MANIFEST_FILE,
      GO_MODULE_WALK_IGNORED_DIRS,
    );
    this.bound = { root, map: GoModuleMap.fromManifests(files, root) };
  }
}
