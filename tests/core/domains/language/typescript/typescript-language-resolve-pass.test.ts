/**
 * The bulk-pass hint, end to end through the TypeScript vertical
 * (bd tea-rags-mcp-6aytq).
 *
 * Pass-2 announces how many files of a language it is about to resolve; the
 * `TypeScriptLanguage` adapter binds the resolver for the root the plan names
 * and forwards, and `TSCallResolver` turns that into an immediate
 * whole-project Program instead of the warm-up gate's 66 per-entry builds.
 *
 * The observable is `loadTsConfigFileNames` — the thunk the cache calls ONLY
 * when a whole build is actually going to happen — so a call proves the prime
 * reached the cache, and the argument proves which root it primed for.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TypeScriptLanguage } from "../../../../../src/core/domains/language/typescript/index.js";
import { TSCallResolver } from "../../../../../src/core/domains/language/typescript/resolver/index.js";
import type * as TsConfigLoader from "../../../../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import { loadTsConfigFileNames } from "../../../../../src/core/domains/language/typescript/resolver/ts-config-loader.js";

vi.mock("../../../../../src/core/domains/language/typescript/resolver/ts-config-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TsConfigLoader>();
  return { ...actual, loadTsConfigFileNames: vi.fn(actual.loadTsConfigFileNames) };
});

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("TypeScript resolve-pass preparation (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    // realpath: macOS `/var` → `/private/var`, and the compiler host reports
    // realpaths — the cache must agree with them for relPath math.
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-resolve-pass-")));
    writeSource(repoRoot, "tsconfig.json", `{ "include": ["src/**/*"] }\n`);
    writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`);
    writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 2;\n}\n`);
    vi.mocked(loadTsConfigFileNames).mockClear();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("primes the whole-project Program for the root the plan names, not the fallback root", () => {
    // The fallback root is deliberately NOT the project: a force-resolve run
    // names its root on the plan, exactly as it does on every CallContext.
    const language = new TypeScriptLanguage("strict", join(repoRoot, "not-the-project"));

    language.resolver.prepareResolvePass?.({ expectedFileCount: 500, projectRoot: repoRoot });

    expect(vi.mocked(loadTsConfigFileNames)).toHaveBeenCalledWith(repoRoot);
  });

  it("builds nothing when the declared volume is under the warm-up gate", () => {
    const language = new TypeScriptLanguage("strict", repoRoot);

    language.resolver.prepareResolvePass?.({ expectedFileCount: 1, projectRoot: repoRoot });

    expect(vi.mocked(loadTsConfigFileNames)).not.toHaveBeenCalled();
  });

  it("hands the declared volume to the resolver's own Program cache", () => {
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    resolver.prepareResolvePass({ expectedFileCount: 500 });

    expect(resolver.programCache?.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });
});
