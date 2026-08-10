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

/**
 * Install a declaration-only package under `repoRoot/node_modules`, the layout
 * every real project has. Returns the absolute path of its `.d.ts` — the file
 * the compiler parses through the cache's shared host when a project source
 * imports `name`.
 */
function writeDependency(repoRoot: string, name: string): string {
  writeSource(repoRoot, `node_modules/${name}/package.json`, `{ "name": "${name}", "types": "index.d.ts" }\n`);
  return writeSource(repoRoot, `node_modules/${name}/index.d.ts`, `export declare const ${name}: number;\n`);
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

  it("maps a dependency under the repo root to an ordinary RelPath — the boundary is the DIRECTORY", () => {
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    expect(cache.toRelPath(join(repoRoot, "node_modules", "express", "index.d.ts"))).toBe(
      "node_modules/express/index.d.ts",
    );
  });
});

/**
 * bd tea-rags-mcp-otm6n — "inside the repo directory" and "one of the project's
 * sources" are different questions, and conflating them is a defect.
 *
 * `node_modules` lives inside the repo root, so {@link TSProgramCache.toRelPath}
 * hands a dependency's `.d.ts` a perfectly ordinary `RelPath` — as the case
 * directly above pins. Consumers that read that as "this declaration belongs to
 * the project" therefore count every dependency as project code, and, wherever
 * the running compiler resolves under the same root, every default-lib file too.
 */
describe("TSProgramCache tells project sources from dependencies (bd tea-rags-mcp-otm6n)", () => {
  let repoRoot: string;
  const tsOptions = { baseUrl: ".", paths: {} };

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-project-source-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const cache = (): TSProgramCache => new TSProgramCache({ repoRoot, tsOptions });

  it("does not count a dependency declaration under the repo root as a project source", () => {
    expect(cache().isProjectSourceFile(join(repoRoot, "node_modules/express/index.d.ts"))).toBe(false);
  });

  it("does not count a default lib shipped inside the repo root as a project source", () => {
    expect(cache().isProjectSourceFile(join(repoRoot, "node_modules/typescript/lib/lib.es2022.full.d.ts"))).toBe(false);
  });

  it("does not count a NESTED workspace dependency as a project source", () => {
    expect(cache().isProjectSourceFile(join(repoRoot, "packages/web/node_modules/left-pad/index.d.ts"))).toBe(false);
  });

  it("counts an ordinary project file as a project source", () => {
    expect(cache().isProjectSourceFile(join(repoRoot, "src/core/app.ts"))).toBe(true);
  });

  it("counts a project's own hand-written .d.ts as a project source", () => {
    expect(cache().isProjectSourceFile(join(repoRoot, "types/globals.d.ts"))).toBe(true);
  });

  it("counts a path merely NAMED like a dependency as a project source", () => {
    expect(cache().isProjectSourceFile(join(repoRoot, "src/node_modules_helper.ts"))).toBe(true);
  });

  it("does not count a file outside the repo root at all", () => {
    expect(cache().isProjectSourceFile("/elsewhere/lib.d.ts")).toBe(false);
  });

  it("yields the RelPath for a project source, so an edge can point at it", () => {
    expect(cache().toProjectSourceRelPath(join(repoRoot, "src", "nested", "a.ts"))).toBe("src/nested/a.ts");
  });

  it("yields null for a dependency, so no edge can point at a file the index lacks", () => {
    expect(cache().toProjectSourceRelPath(join(repoRoot, "node_modules", "express", "index.d.ts"))).toBeNull();
  });
});

/**
 * bd tea-rags-mcp-qb2s3 — the parse-cache bound counts PROJECT sources, and a
 * dependency parse is never evicted.
 *
 * {@link TSProgramCacheOptions.maxParsedFiles} promises exactly that: a
 * dependency's `.d.ts` and the default lib "do not count and are never evicted
 * — re-parsing those is the cost the map exists to avoid, and their number is
 * bounded by the dependency set rather than by how long the process has been
 * alive."
 *
 * Bounding by {@link TSProgramCache.toRelPath} breaks that promise wherever
 * `node_modules` sits under the indexed root, which is the normal layout. The
 * boundary that check draws is the repo DIRECTORY, so every dependency parse
 * counts against the cap and is eligible for eviction — and the eviction walks
 * insertion order, so the expensive early parses go first. The default lib is
 * the worst case: with the running compiler installed under the root,
 * `lib.es2022.full.d.ts` is evicted and re-parsed for later Programs, which is
 * the single cost this cache was built to avoid.
 */
describe("TSProgramCache bounds the parse cache by project sources, not by repo directory (bd tea-rags-mcp-qb2s3)", () => {
  let repoRoot: string;
  const tsOptions = { baseUrl: ".", paths: {} };

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-parse-bound-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does not count a dependency parsed under the repo root toward the bound", () => {
    const depAbs = writeDependency(repoRoot, "dep");
    writeSource(repoRoot, "src/a.ts", `import { dep } from "dep";\nexport const a = dep;\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions });

    const handle = cache.acquire("src/a.ts");

    // The dependency really did go through the shared host — without this the
    // count below would be trivially right for the wrong reason.
    expect(handle?.program.getSourceFile(depAbs)).toBeDefined();
    // Only `src/a.ts` is a project source; the dependency is the cache's asset,
    // not its debt.
    expect(cache.parsedProjectFileCount).toBe(1);
  });

  it("never evicts a dependency parse, however far project sources overflow the bound", () => {
    const depAbs = writeDependency(repoRoot, "dep");
    for (let i = 0; i < 5; i++) {
      writeSource(repoRoot, `src/f${i}.ts`, `import { dep } from "dep";\nexport const f${i} = dep;\n`);
    }
    const cache = new TSProgramCache({ repoRoot, tsOptions, maxEntries: 8, maxParsedFiles: 2 });

    const first = cache.acquire("src/f0.ts");
    const depSourceFile = first?.program.getSourceFile(depAbs);
    // Overflow the bound several times over with project sources.
    for (let i = 1; i <= 3; i++) cache.acquire(`src/f${i}.ts`);
    const last = cache.acquire("src/f4.ts");

    // Object identity: the last Program was handed the SAME parse the first one
    // made. A re-parse would be a different object — the cost the map exists to
    // avoid, paid because a project-source cap reached across into dependencies.
    expect(last?.program.getSourceFile(depAbs)).toBe(depSourceFile);
    // The bound still binds the thing it is meant to bind.
    expect(cache.parsedProjectFileCount).toBeLessThanOrEqual(2);
  });
});
