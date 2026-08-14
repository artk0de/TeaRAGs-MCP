import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TS_PROGRAM_CACHE_MAX_DEFAULT,
  TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT,
  TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
  TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import {
  resolveProgramCacheBudgets,
  TSCallResolver,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";

/** Write `content` at `repoRoot/relPath`, creating parent directories. */
function writeSource(repoRoot: string, relPath: string, content: string): string {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

/** Install a declaration-only package under `repoRoot/node_modules`. */
function writeDependency(repoRoot: string, name: string): void {
  writeSource(repoRoot, `node_modules/${name}/package.json`, `{ "name": "${name}", "types": "index.d.ts" }\n`);
  writeSource(repoRoot, `node_modules/${name}/index.d.ts`, `export declare const ${name}: number;\n`);
}

/**
 * Run `fn` with `vars` applied to `process.env`, restoring the previous state
 * afterwards. The knobs are read in `TSCallResolver`'s constructor, so the
 * resolver must be built INSIDE the callback for the override to reach it.
 */
function withEnv<T>(vars: Readonly<Record<string, string>>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveProgramCacheBudgets (bd tea-rags-mcp-6aytq)", () => {
  it("falls back to the compiled-in defaults when no knob is set", () => {
    expect(resolveProgramCacheBudgets({})).toEqual({
      maxEntries: TS_PROGRAM_CACHE_MAX_DEFAULT,
      maxParsedFiles: TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
      maxDependencyFiles: TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT,
      maxRetainedSourceTextBytes: TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT,
    });
  });

  it("reads all four budgets from the environment, converting retained text from MB to bytes", () => {
    expect(
      resolveProgramCacheBudgets({
        CODEGRAPH_TS_PROGRAM_CACHE_MAX: "16",
        CODEGRAPH_TS_PROGRAM_PARSED_FILES_MAX: "20000",
        CODEGRAPH_TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX: "30000",
        CODEGRAPH_TS_PROGRAM_RETAINED_TEXT_MB: "256",
      }),
    ).toEqual({
      maxEntries: 16,
      maxParsedFiles: 20000,
      maxDependencyFiles: 30000,
      maxRetainedSourceTextBytes: 256 * 1024 * 1024,
    });
  });

  it("falls back per knob on a non-positive, fractional or non-numeric value", () => {
    for (const raw of ["0", "-4", "abc", "", " ", "2.5"]) {
      expect(
        resolveProgramCacheBudgets({
          CODEGRAPH_TS_PROGRAM_CACHE_MAX: raw,
          CODEGRAPH_TS_PROGRAM_PARSED_FILES_MAX: raw,
          CODEGRAPH_TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX: raw,
          CODEGRAPH_TS_PROGRAM_RETAINED_TEXT_MB: raw,
        }),
      ).toEqual({
        maxEntries: TS_PROGRAM_CACHE_MAX_DEFAULT,
        maxParsedFiles: TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
        maxDependencyFiles: TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT,
        maxRetainedSourceTextBytes: TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT,
      });
    }
  });

  it("overrides one knob without disturbing the other three", () => {
    expect(resolveProgramCacheBudgets({ CODEGRAPH_TS_PROGRAM_CACHE_MAX: "3" })).toEqual({
      maxEntries: 3,
      maxParsedFiles: TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
      maxDependencyFiles: TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT,
      maxRetainedSourceTextBytes: TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT,
    });
  });
});

describe("TSCallResolver wires the budget knobs into its TSProgramCache (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    // realpath: macOS `/var` → `/private/var`, and the TS compiler host reports
    // realpaths — the cache must agree with them for relPath math.
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-budgets-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Two entry files with no import relationship — neither Program covers the other. */
  function writeTwoUnrelatedEntries(): void {
    writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`);
    writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 2;\n}\n`);
  }

  it("retains both Programs at the default cache max and only the newest at CODEGRAPH_TS_PROGRAM_CACHE_MAX=1", () => {
    writeTwoUnrelatedEntries();

    const uncapped = new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot);
    uncapped.programCache?.acquire("src/a.ts");
    uncapped.programCache?.acquire("src/b.ts");
    expect(uncapped.programCache?.size).toBe(2);

    const capped = withEnv(
      { CODEGRAPH_TS_PROGRAM_CACHE_MAX: "1" },
      () => new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot),
    );
    capped.programCache?.acquire("src/a.ts");
    capped.programCache?.acquire("src/b.ts");

    expect(capped.programCache?.size).toBe(1);
  });

  it("bounds the shared parse cache's project sources by CODEGRAPH_TS_PROGRAM_PARSED_FILES_MAX", () => {
    writeTwoUnrelatedEntries();

    const capped = withEnv(
      { CODEGRAPH_TS_PROGRAM_PARSED_FILES_MAX: "1" },
      () => new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot),
    );
    capped.programCache?.acquire("src/a.ts");
    capped.programCache?.acquire("src/b.ts");

    expect(capped.programCache?.parsedProjectFileCount).toBe(1);
  });

  it("bounds the shared parse cache's dependency declarations by CODEGRAPH_TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX", () => {
    writeDependency(repoRoot, "alpha");
    writeDependency(repoRoot, "beta");
    writeSource(repoRoot, "src/a.ts", `import { alpha } from "alpha";\n\nexport const a = alpha;\n`);
    writeSource(repoRoot, "src/b.ts", `import { beta } from "beta";\n\nexport const b = beta;\n`);

    const uncapped = new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot);
    uncapped.programCache?.acquire("src/a.ts");
    uncapped.programCache?.acquire("src/b.ts");
    expect(uncapped.programCache?.parsedDependencyFileCount).toBe(2);

    const capped = withEnv(
      { CODEGRAPH_TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX: "1" },
      () => new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot),
    );
    capped.programCache?.acquire("src/a.ts");
    capped.programCache?.acquire("src/b.ts");

    expect(capped.programCache?.parsedDependencyFileCount).toBe(1);
  });

  it("bounds retained Program text by CODEGRAPH_TS_PROGRAM_RETAINED_TEXT_MB", () => {
    // Each entry carries >1 MiB of source text, so a 1 MiB budget cannot hold
    // two Programs while the 16 MiB default holds both.
    const filler = `// ${"x".repeat(1_200_000)}\n`;
    writeSource(repoRoot, "src/a.ts", `${filler}export function a(): number {\n  return 1;\n}\n`);
    writeSource(repoRoot, "src/b.ts", `${filler}export function b(): number {\n  return 2;\n}\n`);

    const uncapped = new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot);
    uncapped.programCache?.acquire("src/a.ts");
    uncapped.programCache?.acquire("src/b.ts");
    expect(uncapped.programCache?.size).toBe(2);

    const capped = withEnv(
      { CODEGRAPH_TS_PROGRAM_RETAINED_TEXT_MB: "1" },
      () => new TSCallResolver({ baseUrl: ".", paths: {} }, undefined, repoRoot),
    );
    capped.programCache?.acquire("src/a.ts");
    capped.programCache?.acquire("src/b.ts");

    expect(capped.programCache?.size).toBe(1);
  });
});
