/**
 * `TSSourceFileStore` carries TypeScript parses from one codegraph run to the
 * next inside a long-lived process (the warm working-tree graph child). Every
 * read re-validates the file's stamp, so a reused parse is the parse a cold run
 * would have made: same path, same mtime and size, same parse options.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import {
  TS_SOURCE_FILE_STORE_TEXT_BYTES_DEFAULT,
  TSSourceFileStore,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-source-file-store.js";

const tsOptions = { baseUrl: ".", paths: {} };

describe("TSSourceFileStore", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ts-source-store-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): string {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  /** Move a file's mtime forward, as an editor save after the previous run does. */
  function touchForward(abs: string): void {
    const { mtime } = statSync(abs);
    const later = new Date(mtime.getTime() + 5_000);
    utimesSync(abs, later, later);
  }

  function parser(abs: string): { parse: () => ts.SourceFile | undefined; calls: () => number } {
    let calls = 0;
    return {
      parse: () => {
        calls += 1;
        return ts.createSourceFile(abs, ts.sys.readFile(abs) ?? "", ts.ScriptTarget.ES2022);
      },
      calls: () => calls,
    };
  }

  it("hands back the stored parse while the file's stamp holds, and counts it as reused", () => {
    const abs = write("src/a.ts", "export const a = 1;\n");
    const store = new TSSourceFileStore();
    const first = parser(abs);

    const parsed = store.getOrParse(abs, "v1", first.parse);
    const reused = store.getOrParse(abs, "v1", first.parse);

    expect(reused).toBe(parsed);
    expect(first.calls()).toBe(1);
    expect(store.usage()).toMatchObject({ reused: 1, parsed: 1, retainedFiles: 1 });
  });

  it("re-parses a file rewritten since it was stored", () => {
    const abs = write("src/a.ts", "export const a = 1;\n");
    const store = new TSSourceFileStore();
    const p = parser(abs);
    const before = store.getOrParse(abs, "v1", p.parse);

    writeFileSync(abs, "export const a = 22;\n", "utf8");
    touchForward(abs);
    const after = store.getOrParse(abs, "v1", p.parse);

    expect(after).not.toBe(before);
    expect(after?.text).toBe("export const a = 22;\n");
    expect(p.calls()).toBe(2);
    expect(store.usage()).toMatchObject({ reused: 0, parsed: 2, retainedFiles: 1 });
  });

  it("re-parses under different parse options", () => {
    const abs = write("src/a.ts", "export const a = 1;\n");
    const store = new TSSourceFileStore();
    const p = parser(abs);

    store.getOrParse(abs, "v1", p.parse);
    store.getOrParse(abs, "v2", p.parse);

    expect(p.calls()).toBe(2);
  });

  it("never stores a file that is not on disk", () => {
    const abs = write("src/a.ts", "export const a = 1;\n");
    unlinkSync(abs);
    const store = new TSSourceFileStore();
    const p = parser(abs);

    store.getOrParse(abs, "v1", p.parse);
    store.getOrParse(abs, "v1", p.parse);

    expect(p.calls()).toBe(2);
    expect(store.usage().retainedFiles).toBe(0);
  });

  it("drops a stored parse once its file is deleted", () => {
    const abs = write("src/a.ts", "export const a = 1;\n");
    const store = new TSSourceFileStore();
    const p = parser(abs);
    store.getOrParse(abs, "v1", p.parse);

    unlinkSync(abs);
    store.getOrParse(abs, "v1", p.parse);

    expect(store.usage().retainedFiles).toBe(0);
  });

  it("bounds the text it retains, least recently used first, and never counts an exempt file", () => {
    const body = "export const value = 1234567890;\n";
    const a = write("src/a.ts", body);
    const b = write("src/b.ts", body);
    const c = write("src/c.ts", body);
    const lib = write("lib/lib.d.ts", body.repeat(10));
    const store = new TSSourceFileStore(body.length * 2);

    store.getOrParse(lib, "v1", parser(lib).parse, { exempt: true });
    store.getOrParse(a, "v1", parser(a).parse);
    store.getOrParse(b, "v1", parser(b).parse);
    store.getOrParse(a, "v1", parser(a).parse);
    store.getOrParse(c, "v1", parser(c).parse);

    expect(store.usage().retainedTextBytes).toBe(body.length * 2);
    const reparsedB = parser(b);
    store.getOrParse(b, "v1", reparsedB.parse);
    expect(reparsedB.calls()).toBe(1);
    const reusedLib = parser(lib);
    store.getOrParse(lib, "v1", reusedLib.parse, { exempt: true });
    expect(reusedLib.calls()).toBe(0);
  });

  it("defaults its budget to the run-level parse budget, 25 MB of source text", () => {
    expect(TS_SOURCE_FILE_STORE_TEXT_BYTES_DEFAULT).toBe(25 * 1024 * 1024);
  });
});

describe("TSProgramCache over a shared TSSourceFileStore (a run after a run)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-store-cache-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): string {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  function cacheOver(store: TSSourceFileStore): TSProgramCache {
    return new TSProgramCache({ repoRoot, tsOptions, strategy: "coverage", sourceFileStore: store });
  }

  it("a second run's Program is built from the first run's parses, the default lib included", () => {
    write("src/k.ts", "export function k(): number {\n  return 7;\n}\n");
    write("src/a.ts", 'import { k } from "./k";\nexport const a = k();\n');
    const store = new TSSourceFileStore();

    const firstRun = cacheOver(store).acquire("src/a.ts");
    const parsedByFirst = store.usage().parsed;
    const secondRun = cacheOver(store).acquire("src/a.ts");

    expect(firstRun).not.toBeNull();
    expect(secondRun).not.toBeNull();
    expect(secondRun?.program).not.toBe(firstRun?.program);
    const kPath = join(repoRoot, "src/k.ts");
    expect(secondRun?.program.getSourceFile(kPath)).toBe(firstRun?.program.getSourceFile(kPath));
    expect(store.usage().parsed).toBe(parsedByFirst);
    expect(store.usage().reused).toBeGreaterThan(0);
  });

  it("a dependency edited between the runs is re-parsed, and the second run's checker sees the edit", () => {
    const kAbs = write("src/k.ts", "export function k(): number {\n  return 7;\n}\n");
    write("src/a.ts", 'import { k } from "./k";\nexport const a = k();\n');
    const store = new TSSourceFileStore();
    const firstRun = cacheOver(store).acquire("src/a.ts");

    writeFileSync(kAbs, "export function k(): string {\n  return 'seven';\n}\n", "utf8");
    const { mtime } = statSync(kAbs);
    const later = new Date(mtime.getTime() + 5_000);
    utimesSync(kAbs, later, later);
    const secondRun = cacheOver(store).acquire("src/a.ts");

    expect(secondRun?.program.getSourceFile(kAbs)).not.toBe(firstRun?.program.getSourceFile(kAbs));
    expect(secondRun?.program.getSourceFile(kAbs)?.text).toContain("'seven'");
    const checker = secondRun?.checker;
    const aFile = secondRun?.sourceFile;
    if (!checker || !aFile) throw new Error("second run built no Program");
    const decl = aFile.statements.find(ts.isVariableStatement)?.declarationList.declarations[0];
    if (!decl) throw new Error("a.ts lost its declaration");
    expect(checker.typeToString(checker.getTypeAtLocation(decl.name))).toBe("string");
  });
});
