import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listModuleSharingTestFiles, requiresModuleIsolation } from "./test-module-isolation.js";

describe("requiresModuleIsolation", () => {
  it.each([
    ["vi.mock", 'vi.mock("node:fs", () => ({}));'],
    ["vi.doMock", 'vi.doMock("./a.js");'],
    ["vi.unmock", 'vi.unmock("./a.js");'],
    ["vi.doUnmock", 'vi.doUnmock("./a.js");'],
    ["vi.hoisted", "const h = vi.hoisted(() => 1);"],
    ["vi.stubEnv", 'vi.stubEnv("HOME", "/tmp");'],
    ["vi.stubGlobal", 'vi.stubGlobal("fetch", f);'],
    ["vi.useFakeTimers", "vi.useFakeTimers();"],
    ["vi.resetModules", "vi.resetModules();"],
    ["vi.importActual", 'await vi.importActual("./a.js");'],
    ["vi.importMock", 'await vi.importMock("./a.js");'],
    ["a process.env property assignment", 'process.env.HOME = "/tmp";'],
    ["a process.env index assignment", 'process.env["HOME"] = "/tmp";'],
    ["a process.env delete", "delete process.env.HOME;"],
    ["process.chdir", "process.chdir(dir);"],
    ["process.exit", "process.exit(1);"],
    ["process.on", 'process.on("exit", f);'],
    ["process.once", 'process.once("exit", f);'],
    ["a process property redefinition", 'Object.defineProperty(process, "cwd", { value: () => tmp });'],
    ["child_process", 'import { fork } from "node:child_process";'],
    ["execFileSync", 'execFileSync("git", ["status"]);'],
    ["execSync", 'execSync("git status");'],
    ["spawnSync", 'spawnSync("git", []);'],
    ["fork", 'fork("./worker.js");'],
    ["spawn", 'spawn("git", []);'],
    ["ChunkerPool", "const pool = new ChunkerPool(2);"],
    ["ProcessTransport", "new ProcessTransport(path);"],
    ["worker_threads", 'import { Worker } from "node:worker_threads";'],
    ["new Worker", "const w = new Worker(url);"],
    ["a globalThis assignment", "globalThis.fetch = f;"],
    ["setDebug", "setDebug(true);"],
    ["installTestFileConventions", "installTestFileConventions();"],
  ])("isolates a file that uses %s", (_label, source) => {
    expect(requiresModuleIsolation(`import { it } from "vitest";\n${source}\n`)).toBe(true);
  });

  it.each([
    ["a plain unit test", 'import { add } from "../src/add.js";\nit("adds", () => expect(add(1, 2)).toBe(3));'],
    ["vi.fn spies", "const f = vi.fn();\nvi.spyOn(obj, 'm');"],
    ["a process.env read", "const home = process.env.HOME;"],
    ["a process.env comparison", 'if (process.env.CI === "1") {}'],
    ["a globalThis comparison", "if (globalThis.fetch == null) {}"],
  ])("shares modules for %s", (_label, source) => {
    expect(requiresModuleIsolation(source)).toBe(false);
  });
});

describe("listModuleSharingTestFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "test-module-isolation-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeTest = (relativePath: string, source: string): void => {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  };

  it("lists the test files under the test dir that need no isolation, sorted and root-relative", () => {
    writeTest("tests/z/plain.test.ts", 'it("a", () => {});');
    writeTest("tests/a/deep/plain.test.ts", 'it("b", () => {});');
    writeTest("tests/b.test.ts", 'it("c", () => {});');
    writeTest("tests/mocked.test.ts", 'vi.mock("./x.js");');
    writeTest("tests/helper.ts", "export const x = 1;");
    writeTest("src/outside.test.ts", 'it("d", () => {});');

    expect(listModuleSharingTestFiles(root, "tests")).toEqual([
      "tests/a/deep/plain.test.ts",
      "tests/b.test.ts",
      "tests/z/plain.test.ts",
    ]);
  });

  it("returns the same list on every call", () => {
    for (const name of ["c", "a", "b"]) writeTest(`tests/${name}.test.ts`, 'it("x", () => {});');

    expect(listModuleSharingTestFiles(root, "tests")).toEqual(listModuleSharingTestFiles(root, "tests"));
  });
});
