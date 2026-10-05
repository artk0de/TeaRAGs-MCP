/**
 * The dependency-manifest walk (bd tea-rags-mcp-w205u.1).
 *
 * A Python project does not declare its dependencies in one file at a known
 * place. polar declares them in `server/pyproject.toml`, ugnest in both a root
 * `pyproject.toml` and two `requirements*.txt`, netbox in `requirements.txt`
 * while its `pyproject.toml` marks dependencies dynamic. So the walk is
 * recursive and the answer is the UNION — and it has to stay out of the vendored
 * trees, where a checked-in virtualenv would otherwise contribute the whole
 * transitive world and defeat the gate it feeds.
 *
 * The filesystem half lives here, in infra, because both consumers need it and
 * neither may import the other: the codegraph run state reads it once per run,
 * and the chunker worker — a second composition root — reads it once per worker.
 * `domains/language` contributes the recognizing and the parsing, never the walk.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DependencyManifestSource } from "../../../src/core/contracts/types/language.js";
import { PYTHON_DEPENDENCY_MANIFEST } from "../../../src/core/domains/language/python/manifest.js";
import { RUBY_DEPENDENCY_MANIFEST } from "../../../src/core/domains/language/ruby/gemfile.js";
import {
  readDeclaredDependencies,
  readDeclaredDependenciesByLanguage,
  readManifestFiles,
} from "../../../src/core/infra/dependency-manifests.js";

const SOURCES: readonly DependencyManifestSource[] = [PYTHON_DEPENDENCY_MANIFEST];

let root: string;

function write(relPath: string, body: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tea-rags-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readDeclaredDependencies", () => {
  it("answers undefined when the project declares no manifest anywhere", () => {
    write("app/models.py", "class Site: pass\n");
    expect(readDeclaredDependencies(root, SOURCES)).toBeUndefined();
  });

  it("finds a manifest NESTED under the root — polar's server/pyproject.toml shape", () => {
    write("server/pyproject.toml", '[project]\ndependencies = ["fastapi", "sqlalchemy"]\n');
    expect([...(readDeclaredDependencies(root, SOURCES) ?? [])].sort()).toEqual(["fastapi", "sqlalchemy"]);
  });

  it("unions every manifest it finds, normalized and deduplicated", () => {
    write("pyproject.toml", '[project]\ndependencies = ["django>=6.0.3"]\n');
    write("requirements.txt", "Django==6.0.3\ndjango-filter==24.3\n");
    write("requirements-dev.txt", "pytest-django==4.9.0\n");
    expect([...(readDeclaredDependencies(root, SOURCES) ?? [])].sort()).toEqual([
      "django",
      "django-filter",
      "pytest-django",
    ]);
  });

  it("never descends into a vendored or ignored directory", () => {
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    for (const dir of [".venv", "venv", "node_modules", "build", "dist", "site-packages"]) {
      write(join(dir, "requirements.txt"), "django==6.0.3\n");
    }
    write(join(".git", "requirements.txt"), "django==6.0.3\n");
    expect([...(readDeclaredDependencies(root, SOURCES) ?? [])]).toEqual(["flask"]);
  });

  it("descends into `vendor/` — skipping it is the Go module map's own rule, not the shared walk's", () => {
    // A Python repository's manifests under vendor/ (a vendored framework
    // facet) are read exactly as before the Go module map existed: the Go
    // consumer asks for the skip, the shared default never grew it.
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    write(join("vendor", "requirements.txt"), "django==6.0.3\n");
    expect([...(readDeclaredDependencies(root, SOURCES) ?? [])].sort()).toEqual(["django", "flask"]);
  });

  it("descends 4 levels and no further — the bound that keeps a root of `/` finite", () => {
    // 2 is the deepest a real corpus puts one (polar's sdk/generator), so the
    // bound has to clear that; the 5th level is what a caller handing the walk
    // an arbitrary root must not be able to turn into a whole-disk recursion.
    write(join("a", "b", "pyproject.toml"), '[project]\ndependencies = ["shallow"]\n');
    write(join("a", "b", "c", "d", "pyproject.toml"), '[project]\ndependencies = ["deep"]\n');
    write(join("a", "b", "c", "d", "e", "pyproject.toml"), '[project]\ndependencies = ["too-deep"]\n');
    expect([...(readDeclaredDependencies(root, SOURCES) ?? [])].sort()).toEqual(["deep", "shallow"]);
  });

  it("answers an EMPTY set — present, declaring nothing — for a manifest with no dependencies", () => {
    write("pyproject.toml", '[build-system]\nrequires = ["hatchling"]\n');
    const declared = readDeclaredDependencies(root, SOURCES);
    expect(declared).toBeDefined();
    expect(declared?.size).toBe(0);
  });

  it("answers undefined for a root that does not exist, rather than throwing", () => {
    expect(readDeclaredDependencies(join(root, "nope"), SOURCES)).toBeUndefined();
  });

  it("answers undefined when no language contributes a manifest source", () => {
    write("pyproject.toml", '[project]\ndependencies = ["django"]\n');
    expect(readDeclaredDependencies(root, [])).toBeUndefined();
  });

  // Object.freeze marks the value; it cannot seal a Set's entries, so this
  // asserts the marking, which is what tells a reader the set is run-global.
  it("returns a frozen set object", () => {
    write("pyproject.toml", '[project]\ndependencies = ["django"]\n');
    const declared = readDeclaredDependencies(root, SOURCES);
    expect(Object.isFrozen(declared)).toBe(true);
  });
});

/**
 * The same walk, handing back each manifest's LOCATION and content rather than
 * a union of names (bd tea-rags-mcp-e6xx). Go's `go.mod` is not a dependency
 * list the vocabulary gate consumes: what a Go resolver needs is which module
 * path each directory tree declares, and a multi-module repository declares one
 * per nested `go.mod`, so the answer has to say where each file sits.
 */
describe("readManifestFiles", () => {
  const isGoMod = (name: string): boolean => name === "go.mod";

  it("returns each matching file with its repo-relative directory, the root as ''", () => {
    write("go.mod", "module example.com/app\n");
    write(join("tools", "lint", "go.mod"), "module example.com/app/tools/lint\n");
    write(join("tools", "lint", "main.go"), "package main\n");
    const found = readManifestFiles(root, isGoMod).sort((a, b) => a.relDir.localeCompare(b.relDir));
    expect(found).toEqual([
      { relDir: "", fileName: "go.mod", content: "module example.com/app\n" },
      { relDir: "tools/lint", fileName: "go.mod", content: "module example.com/app/tools/lint\n" },
    ]);
  });

  it("shares the walk's bounds: no vendored trees, no deeper than 4 levels", () => {
    write(join("node_modules", "x", "go.mod"), "module vendored\n");
    write(join("a", "b", "c", "d", "e", "go.mod"), "module too.deep\n");
    expect(readManifestFiles(root, isGoMod)).toEqual([]);
  });

  it("skips the extra directories its caller names, and only for that caller", () => {
    write(join("vendor", "github.com", "dep", "go.mod"), "module github.com/dep\n");
    expect(readManifestFiles(root, isGoMod, new Set(["vendor"]))).toEqual([]);
    expect(readManifestFiles(root, isGoMod).map((file) => file.relDir)).toEqual(["vendor/github.com/dep"]);
  });

  it("answers an empty list for a root that does not exist, rather than throwing", () => {
    expect(readManifestFiles(join(root, "nope"), isGoMod)).toEqual([]);
  });
});

/**
 * Ruby's manifest is the ROOT `Gemfile` alone (bd tea-rags-mcp-m99j1.1.8) — the
 * exact file the `gemfileContent` channel used to read: never `Gemfile.lock` (the
 * resolved transitive tree), never a nested engine's Gemfile, never a gemspec.
 */
describe("RUBY_DEPENDENCY_MANIFEST", () => {
  const RUBY: readonly DependencyManifestSource[] = [RUBY_DEPENDENCY_MANIFEST];

  it("declares the gems of the root Gemfile", () => {
    write("Gemfile", 'source "https://rubygems.org"\ngem "rails"\ngroup :test do\n  gem "rspec-rails"\nend\n');
    expect([...(readDeclaredDependencies(root, RUBY) ?? [])].sort()).toEqual(["rails", "rspec-rails"]);
  });

  it("answers undefined without a root Gemfile, whatever Gemfile.lock, gemspec or nested Gemfile exist", () => {
    write("Gemfile.lock", "GEM\n  specs:\n    rails (7.0.0)\n");
    write("sinatra.gemspec", 's.add_dependency "rack"\n');
    write("engines/billing/Gemfile", 'gem "sidekiq"\n');
    expect(readDeclaredDependencies(root, RUBY)).toBeUndefined();
  });

  it("reads only the root Gemfile when a nested one also exists", () => {
    write("Gemfile", 'gem "rails"\n');
    write("engines/billing/Gemfile", 'gem "sidekiq"\n');
    expect([...(readDeclaredDependencies(root, RUBY) ?? [])]).toEqual(["rails"]);
  });

  it("treats a Gemfile that names only `gemspec` as a manifest declaring nothing", () => {
    write("Gemfile", 'source "https://rubygems.org"\ngemspec\n');
    expect(readDeclaredDependencies(root, RUBY)).toEqual(new Set());
  });
});

describe("readDeclaredDependenciesByLanguage", () => {
  const BY_LANGUAGE = new Map<string, DependencyManifestSource>([
    ["python", PYTHON_DEPENDENCY_MANIFEST],
    ["ruby", RUBY_DEPENDENCY_MANIFEST],
  ]);

  it("keeps each language's declared set apart — a Gemfile never gates Python, a pyproject never gates Ruby", () => {
    write("Gemfile", 'gem "rails"\n');
    write("docs/requirements.txt", "sphinx\n");
    const declared = readDeclaredDependenciesByLanguage(root, BY_LANGUAGE);
    expect([...(declared.get("ruby") ?? [])]).toEqual(["rails"]);
    expect([...(declared.get("python") ?? [])]).toEqual(["sphinx"]);
  });

  it("omits a language whose manifest is absent, so that language keeps every vocabulary", () => {
    write("Gemfile", 'gem "rails"\n');
    const declared = readDeclaredDependenciesByLanguage(root, BY_LANGUAGE);
    expect(declared.has("python")).toBe(false);
    expect(declared.get("ruby")).toEqual(new Set(["rails"]));
  });
});
