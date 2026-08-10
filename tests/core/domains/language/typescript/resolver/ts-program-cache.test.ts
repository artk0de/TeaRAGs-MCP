import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";

/** Write `content` at `repoRoot/relPath`, creating parent directories. */
function writeSource(repoRoot: string, relPath: string, content: string): string {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

describe("TSProgramCache builds per-file Programs from a bounded import closure (bd tea-rags-mcp-uclbn)", () => {
  let repoRoot: string;

  beforeEach(() => {
    // realpath: macOS `/var` → `/private/var`, and the TS compiler host reports
    // realpaths — the cache must agree with them for relPath math.
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-cache-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("exposes a checker that types a value flowing through an in-project import", () => {
    writeSource(
      repoRoot,
      "src/user-repo.ts",
      `export class UserRepo {\n  fetch(id: string): string {\n    return id;\n  }\n}\n`,
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      `import { UserRepo } from "./user-repo.js";\n\nexport function run(): string {\n  const repo = new UserRepo();\n  return repo.fetch("42");\n}\n`,
    );
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    const handle = cache.acquire("src/caller.ts");

    expect(handle).not.toBeNull();
    expect(handle?.sourceFile.fileName).toBe(join(repoRoot, "src/caller.ts"));
    // The transitive import was pulled into the Program's root files, so the
    // checker can see `UserRepo` — the whole point of the closure walk.
    expect(handle?.rootFiles).toContain(join(repoRoot, "src/user-repo.ts"));
  });

  it("returns null for a file that does not exist on disk", () => {
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    expect(cache.acquire("src/missing.ts")).toBeNull();
  });

  it("returns the identical handle on a repeated acquire of the same file", () => {
    writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    const first = cache.acquire("src/a.ts");
    const second = cache.acquire("src/a.ts");

    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("evicts the least-recently-used Program once maxEntries is exceeded", () => {
    writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`);
    writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 2;\n}\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} }, maxEntries: 1 });

    const firstA = cache.acquire("src/a.ts");
    cache.acquire("src/b.ts");
    const secondA = cache.acquire("src/a.ts");

    expect(cache.size).toBe(1);
    expect(secondA).not.toBe(firstA);
  });

  it("rebuilds the Program when the entry file changed on disk since it was built", () => {
    writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });
    const first = cache.acquire("src/a.ts");

    const abs = writeSource(repoRoot, "src/a.ts", `export function a(): string {\n  return "1";\n}\n`);
    const future = new Date(Date.now() + 10_000);
    utimesSync(abs, future, future);
    const second = cache.acquire("src/a.ts");

    expect(second).not.toBe(first);
    expect(second?.sourceFile.text).toContain('return "1"');
  });

  it("caps the import closure at maxRootFiles", () => {
    writeSource(repoRoot, "src/d.ts", `export const d = 4;\n`);
    writeSource(repoRoot, "src/c.ts", `import { d } from "./d.js";\nexport const c = d;\n`);
    writeSource(repoRoot, "src/b.ts", `import { c } from "./c.js";\nexport const b = c;\n`);
    writeSource(repoRoot, "src/a.ts", `import { b } from "./b.js";\nexport const a = b;\n`);
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions: { baseUrl: ".", paths: {} },
      maxRootFiles: 2,
      maxImportDepth: 10,
    });

    const handle = cache.acquire("src/a.ts");

    expect(handle?.rootFiles).toHaveLength(2);
    expect(handle?.rootFiles[0]).toBe(join(repoRoot, "src/a.ts"));
  });

  it("caps the import closure at maxImportDepth", () => {
    writeSource(repoRoot, "src/c.ts", `export const c = 3;\n`);
    writeSource(repoRoot, "src/b.ts", `import { c } from "./c.js";\nexport const b = c;\n`);
    writeSource(repoRoot, "src/a.ts", `import { b } from "./b.js";\nexport const a = b;\n`);
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions: { baseUrl: ".", paths: {} },
      maxImportDepth: 1,
    });

    const handle = cache.acquire("src/a.ts");

    expect(handle?.rootFiles).toEqual([join(repoRoot, "src/a.ts"), join(repoRoot, "src/b.ts")]);
  });

  it("follows tsconfig path aliases when walking the import closure", () => {
    writeSource(repoRoot, "lib/helper.ts", `export const helper = 1;\n`);
    writeSource(repoRoot, "src/a.ts", `import { helper } from "@lib/helper.js";\nexport const a = helper;\n`);
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
    });

    const handle = cache.acquire("src/a.ts");

    expect(handle?.rootFiles).toContain(join(repoRoot, "lib/helper.ts"));
  });

  it("ignores bare npm specifiers instead of treating them as project files", () => {
    writeSource(repoRoot, "src/a.ts", `import { readFile } from "node:fs";\nexport const a = readFile;\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    const handle = cache.acquire("src/a.ts");

    expect(handle?.rootFiles).toEqual([join(repoRoot, "src/a.ts")]);
  });

  it("bounds the shared parsed-source map so a long-lived process cannot grow without limit", () => {
    for (let i = 0; i < 6; i++) {
      writeSource(repoRoot, `src/f${i}.ts`, `export function f${i}(): number {\n  return ${i};\n}\n`);
    }
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions: { baseUrl: ".", paths: {} },
      maxEntries: 6,
      maxParsedFiles: 2,
    });

    for (let i = 0; i < 6; i++) cache.acquire(`src/f${i}.ts`);

    // Project sources are evicted down to the cap; the default lib is exempt —
    // re-parsing it per Program is the cost this map exists to avoid.
    expect(cache.parsedProjectFileCount).toBeLessThanOrEqual(2);
    expect(cache.acquire("src/f0.ts")?.sourceFile.text).toContain("return 0");
  });

  it("keeps walking the closure when an import maps onto something unreadable", () => {
    writeSource(repoRoot, "src/a.ts", `import { b } from "./b.js";\nexport const a = b;\n`);
    // A directory sitting where the import specifier says a module should be —
    // it exists, so the walk admits it, and reading it fails. The closure must
    // absorb that rather than abort mid-walk.
    mkdirSync(join(repoRoot, "src/b.ts"), { recursive: true });
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions: { baseUrl: ".", paths: {} },
      maxImportDepth: 3,
    });

    const handle = cache.acquire("src/a.ts");

    expect(handle?.rootFiles).toEqual([join(repoRoot, "src/a.ts"), join(repoRoot, "src/b.ts")]);
  });

  it("drops every cached Program on reset", () => {
    writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });
    const first = cache.acquire("src/a.ts");

    cache.reset();

    expect(cache.size).toBe(0);
    expect(cache.acquire("src/a.ts")).not.toBe(first);
  });
});

describe("TSProgramCache maps absolute compiler paths back to repo-relative ones (bd tea-rags-mcp-uclbn)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-cache-rel-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("returns a POSIX repo-relative path for a file inside the root", () => {
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    expect(cache.toRelPath(join(repoRoot, "src", "nested", "a.ts"))).toBe("src/nested/a.ts");
  });

  it("returns null for a path outside the repo root", () => {
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    expect(cache.toRelPath(join(repoRoot, "..", "outside.ts"))).toBeNull();
  });
});
