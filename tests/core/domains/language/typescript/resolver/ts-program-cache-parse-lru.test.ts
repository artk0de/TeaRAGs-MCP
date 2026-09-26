/**
 * `TSProgramCache` bounds its shared parse map by source-text bytes (bd
 * tea-rags-mcp-vtuu4) — the policy closure batches need, since consecutive
 * batches reuse most of each other's parses and heap follows retained text.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TS_PROGRAM_PARSED_TEXT_BYTES_MAX_DEFAULT,
  TSProgramCache,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { resolveProgramBatchBudgets } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";

const tsOptions = { baseUrl: ".", paths: {} };

describe("TSProgramCache parse text budget (bd tea-rags-mcp-vtuu4)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-parse-lru-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  it("bounds the project and dependency parses it retains by source text bytes", () => {
    const body = `export function f(): number {\n  return 1;\n}\n`;
    for (const name of ["a", "b", "c", "d"]) write(`src/${name}.ts`, body.replace("f", name));
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "coverage",
      maxEntries: 1,
      maxParsedSourceTextBytes: body.length * 2,
    });

    for (const name of ["a", "b", "c", "d"]) cache.acquire(`src/${name}.ts`);

    expect(cache.parsedSourceTextBytes).toBeGreaterThan(0);
    expect(cache.parsedSourceTextBytes).toBeLessThanOrEqual(body.length * 2);
  });

  it("keeps a parse the next Program touches over an older one it does not", () => {
    // a is parsed first and lone second; building b's Program touches a (b
    // imports it), so when b's own parse overflows the budget the least
    // recently USED parse is lone, not the least recently inserted a.
    const a = `export function a(): number {\n  return 1;\n}\n`;
    const lone = `export function lone(): number {\n  return 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4;\n}\n`;
    const b = `import { a } from "./a";\nexport const b = a();\n`;
    write("src/a.ts", a);
    write("src/lone.ts", lone);
    write("src/b.ts", b);
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "coverage",
      maxEntries: 1,
      maxParsedSourceTextBytes: a.length + lone.length + 1,
    });

    cache.acquire("src/a.ts");
    cache.acquire("src/lone.ts");
    cache.acquire("src/b.ts");

    expect(cache.parsedSourceTextBytes).toBe(a.length + b.length);
  });

  it("defaults the budget to 40 MB of source text", () => {
    expect(TS_PROGRAM_PARSED_TEXT_BYTES_MAX_DEFAULT).toBe(40 * 1024 * 1024);
  });
});

describe("resolveProgramBatchBudgets (bd tea-rags-mcp-vtuu4)", () => {
  it("falls back to the compiled-in parse text budget", () => {
    expect(resolveProgramBatchBudgets({}).maxParsedSourceTextBytes).toBe(TS_PROGRAM_PARSED_TEXT_BYTES_MAX_DEFAULT);
  });

  it("reads the parse text budget from CODEGRAPH_TS_PROGRAM_PARSED_TEXT_MB", () => {
    expect(resolveProgramBatchBudgets({ CODEGRAPH_TS_PROGRAM_PARSED_TEXT_MB: "64" }).maxParsedSourceTextBytes).toBe(
      64 * 1024 * 1024,
    );
    expect(resolveProgramBatchBudgets({ CODEGRAPH_TS_PROGRAM_PARSED_TEXT_MB: "0" }).maxParsedSourceTextBytes).toBe(
      TS_PROGRAM_PARSED_TEXT_BYTES_MAX_DEFAULT,
    );
  });
});
