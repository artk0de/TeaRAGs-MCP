/**
 * The dependency-manifest read in a git work tree lists the tree through
 * `git ls-files` (tracked plus untracked-unignored) instead of walking every
 * directory: a review reads the manifests once per language, and on a large
 * tree each walk was seconds of `readdir`. The walk's own bounds — the shared
 * ignored directories and the depth cap — still apply to the listed paths; a
 * root that is not a git work tree keeps the walk (the suite beside this one).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DependencyManifestSource } from "../../../src/core/contracts/types/language.js";
import { PYTHON_DEPENDENCY_MANIFEST } from "../../../src/core/domains/language/python/manifest.js";
import { RUBY_DEPENDENCY_MANIFEST } from "../../../src/core/domains/language/ruby/gemfile.js";
import {
  readDeclaredDependencies,
  readDeclaredDependenciesByLanguage,
} from "../../../src/core/infra/dependency-manifests.js";

const SOURCES: readonly DependencyManifestSource[] = [PYTHON_DEPENDENCY_MANIFEST];

let root: string;

function write(relPath: string, body: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function declared(sources: readonly DependencyManifestSource[] = SOURCES): string[] {
  return [...(readDeclaredDependencies(root, sources) ?? [])].sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tea-rags-manifest-git-"));
  git("init", "-q");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readDeclaredDependencies in a git work tree", () => {
  it("reads tracked and untracked manifests alike", () => {
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    git("add", "pyproject.toml");
    write("server/requirements.txt", "django==6.0.3\n");
    expect(declared()).toEqual(["django", "flask"]);
  });

  it("does not read a manifest the tree ignores — it is no declaration of the project's", () => {
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    write(".gitignore", "scratch/\n");
    write("scratch/requirements.txt", "django==6.0.3\n");
    expect(declared()).toEqual(["flask"]);
  });

  it("keeps the shared ignored directories out even when their files are tracked", () => {
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    for (const dir of [".venv", "venv", "node_modules", "build", "dist", "site-packages"]) {
      write(join(dir, "requirements.txt"), "django==6.0.3\n");
    }
    write(join("pkg", "node_modules", "dep", "requirements.txt"), "numpy\n");
    git("add", "-A", "-f");
    expect(declared()).toEqual(["flask"]);
  });

  it("keeps the depth bound: 4 levels and no further", () => {
    write(join("a", "b", "pyproject.toml"), '[project]\ndependencies = ["shallow"]\n');
    write(join("a", "b", "c", "d", "pyproject.toml"), '[project]\ndependencies = ["deep"]\n');
    write(join("a", "b", "c", "d", "e", "pyproject.toml"), '[project]\ndependencies = ["too-deep"]\n');
    expect(declared()).toEqual(["deep", "shallow"]);
  });

  it("reads no symlinked manifest and no tracked file the tree has deleted", () => {
    write("real/pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    write("gone/requirements.txt", "django==6.0.3\n");
    git("add", "-A");
    rmSync(join(root, "gone"), { recursive: true });
    mkdirSync(join(root, "linked"));
    symlinkSync(join(root, "real", "pyproject.toml"), join(root, "linked", "requirements.txt"));
    expect(declared()).toEqual(["flask"]);
  });

  it("answers per language from one listing, Ruby still from its root Gemfile alone", () => {
    write("Gemfile", "source 'https://rubygems.org'\ngem 'rails'\n");
    write("nested/Gemfile", "gem 'sinatra'\n");
    write("pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    const byLanguage = readDeclaredDependenciesByLanguage(
      root,
      new Map([
        ["ruby", RUBY_DEPENDENCY_MANIFEST],
        ["python", PYTHON_DEPENDENCY_MANIFEST],
      ]),
    );
    expect([...(byLanguage.get("ruby") ?? [])]).toEqual(["rails"]);
    expect([...(byLanguage.get("python") ?? [])]).toEqual(["flask"]);
  });

  it("a root below the work tree's top keeps the walk — an ignored root still reads its own manifests", () => {
    write(".gitignore", "corpus/\n");
    write("corpus/pyproject.toml", '[project]\ndependencies = ["flask"]\n');
    write("other/requirements.txt", "django==6.0.3\n");
    expect([...(readDeclaredDependencies(join(root, "corpus"), SOURCES) ?? [])]).toEqual(["flask"]);
  });
});
