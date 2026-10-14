/**
 * One review reads the work tree's manifests twice — the declared dependencies
 * and the test-only dependencies — and each read listed the tree through its
 * own `git ls-files` (bd tea-rags-mcp-uqkn5). Inside a sharing scope both reads
 * take one listing per root; outside it every read lists afresh, so a work tree
 * that changes between reviews is never served a stale listing.
 */
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readDeclaredDependenciesByLanguage,
  readDeclaredTestDependencies,
  withSharedWorkTreeListings,
} from "../../../../src/core/adapters/filesystem/dependency-manifests.js";
import { PYTHON_DEPENDENCY_MANIFEST } from "../../../../src/core/domains/language/python/manifest.js";
import { PACKAGE_JSON_TEST_DEPENDENCY_MANIFEST } from "../../../../src/core/domains/language/typescript/package-manifest.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let root: string;

function lsFilesSpawns(): number {
  return vi.mocked(childProcess.execFileSync).mock.calls.filter(([, args]) => (args as string[]).includes("ls-files"))
    .length;
}

function readDeclared(): void {
  readDeclaredDependenciesByLanguage(root, new Map([["python", PYTHON_DEPENDENCY_MANIFEST]]));
}

function readTestOnly(): void {
  readDeclaredTestDependencies(root, [PACKAGE_JSON_TEST_DEPENDENCY_MANIFEST]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tea-rags-manifest-scope-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["flask"]\n', "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3" } }), "utf8");
  vi.mocked(childProcess.execFileSync).mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("work-tree listing scope", () => {
  it("lists the tree once for both reads inside one sharing scope", () => {
    withSharedWorkTreeListings(() => {
      readDeclared();
      readTestOnly();
    });
    expect(lsFilesSpawns()).toBe(1);
  });

  it("shares across the awaits of one async scope", async () => {
    await withSharedWorkTreeListings(async () => {
      readDeclared();
      await Promise.resolve();
      readTestOnly();
    });
    expect(lsFilesSpawns()).toBe(1);
  });

  it("lists afresh outside a scope and in the next scope, so a changing tree is never served stale", () => {
    readDeclared();
    readTestOnly();
    expect(lsFilesSpawns()).toBe(2);
    withSharedWorkTreeListings(() => {
      readDeclared();
      readTestOnly();
    });
    withSharedWorkTreeListings(() => {
      readDeclared();
      readTestOnly();
    });
    expect(lsFilesSpawns()).toBe(4);
  });
});
