/**
 * ts-config-loader tests — covers loadTsConfig's four code paths:
 *   1. tsconfig.json missing → defaults
 *   2. valid JSON → parsed compilerOptions
 *   3. JSONC with comments → comment-stripped before parse
 *   4. unparseable JSON → defaults (try/catch fallback)
 *
 * Each scenario writes to a tmp dir so we exercise the real fs/JSON
 * pipeline. No mocking — the loader is small and pure-IO; reading from
 * disk is the actual behaviour we want to validate against grammar
 * drift in JSON.parse / fs.existsSync.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTsConfig } from "../../../../../../src/core/domains/language/typescript/resolver/ts-config-loader.js";

describe("loadTsConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tsconfig-loader-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the documented default when tsconfig.json is missing", () => {
    const result = loadTsConfig(tmp);
    expect(result).toEqual({ baseUrl: ".", paths: {} });
  });

  it("parses a plain tsconfig.json with compilerOptions.baseUrl and paths", () => {
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: "./src",
          paths: { "@/*": ["./*"], "lib/*": ["lib/*"] },
        },
      }),
    );
    const result = loadTsConfig(tmp);
    expect(result.baseUrl).toBe("src");
    expect(result.paths).toEqual({ "@/*": ["./*"], "lib/*": ["lib/*"] });
  });

  it("strips JSONC block- and line-comments before parsing", () => {
    writeFileSync(
      join(tmp, "tsconfig.json"),
      [
        "/* leading block comment */",
        "{",
        "  // line comment about baseUrl",
        '  "compilerOptions": {',
        '    "baseUrl": "./app",',
        "    /* paths: described inline */",
        '    "paths": { "@app/*": ["./app/*"] }',
        "  }",
        "}",
      ].join("\n"),
    );
    const result = loadTsConfig(tmp);
    expect(result.baseUrl).toBe("app");
    expect(result.paths).toEqual({ "@app/*": ["./app/*"] });
  });

  it("falls back to defaults when tsconfig.json is unparseable", () => {
    writeFileSync(join(tmp, "tsconfig.json"), "{ this is not valid json");
    const result = loadTsConfig(tmp);
    expect(result).toEqual({ baseUrl: ".", paths: {} });
  });

  it("returns defaults when compilerOptions is missing entirely", () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
    const result = loadTsConfig(tmp);
    expect(result).toEqual({ baseUrl: ".", paths: {} });
  });

  it("returns defaults when compilerOptions has only one of baseUrl/paths", () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "./src" } }));
    const result = loadTsConfig(tmp);
    expect(result.baseUrl).toBe("src");
    expect(result.paths).toEqual({});
  });
});

/**
 * A tsconfig is JSONC, not JSON, and `JSON.parse` rejects the half of JSONC
 * that is not comments. taxdome's `tsconfig.json` carries a trailing comma
 * inside `compilerOptions.paths`; the comment-stripping loader threw on it and
 * the catch handed back `{ baseUrl: ".", paths: {} }`. Every one of that
 * project's 107 896 alias imports then mapped to nothing, which the resolver
 * reads as "this call leaves the project" — 78 259 of 189 630 call sites
 * misfiled as external, and a `resolveSuccessRate` computed over the residue.
 *
 * The compiler ships the parser for its own config format. These pin that it
 * is the one being used.
 */
describe("loadTsConfig JSONC + extends (bd tea-rags-mcp-t6ycg)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tsconfig-loader-jsonc-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps paths when the tsconfig carries JSONC trailing commas", () => {
    // Byte-for-byte the shape that broke: trailing comma after the last
    // `paths` entry, and a bare `*` catch-all as the dominant mapping.
    writeFileSync(
      join(tmp, "tsconfig.json"),
      [
        "{",
        '  "compilerOptions": {',
        '    "paths": {',
        '      "playwright/*": ["./playwright/*"],',
        '      "*": ["./app/javascript/*"],',
        '      "api/mocks/*": ["./app/javascript/api/mocks/*"],',
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    const result = loadTsConfig(tmp);
    expect(result.paths).toEqual({
      "playwright/*": ["./playwright/*"],
      "*": ["./app/javascript/*"],
      "api/mocks/*": ["./app/javascript/api/mocks/*"],
    });
  });

  it("inherits compilerOptions.paths through extends", () => {
    writeFileSync(
      join(tmp, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "shared/*": ["./packages/shared/*"] } } }),
    );
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { strict: true } }),
    );
    const result = loadTsConfig(tmp);
    expect(result.paths).toEqual({ "shared/*": ["./packages/shared/*"] });
  });

  it("returns baseUrl relative to the repo root, so a joined alias target stays repo-relative", () => {
    // The mapper does `posix.join(baseUrl, target)` and the Program cache does
    // `resolve(repoRoot, baseUrl)`. Both want a repo-relative baseUrl, and the
    // compiler hands back an absolute one — normalising here is what keeps an
    // `extends` chain from leaking an absolute path into every mapped edge.
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "./src", paths: { "@/*": ["./*"] } } }),
    );
    expect(loadTsConfig(tmp).baseUrl).toBe("src");
  });

  it("returns '.' rather than an empty string when baseUrl IS the repo root", () => {
    // `resolve(repoRoot, "")` is the cwd, not the repo root — the empty string
    // would silently retarget the whole Program cache.
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
    expect(loadTsConfig(tmp).baseUrl).toBe(".");
  });

  it("surfaces the degradation on stderr instead of silently emptying paths", () => {
    // A silent swallow-to-empty-paths is what let the taxdome defect live
    // undetected. Degrading is fine; degrading invisibly is not.
    writeFileSync(join(tmp, "tsconfig.json"), "{ this is not valid json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(loadTsConfig(tmp)).toEqual({ baseUrl: ".", paths: {} });
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("tsconfig");
    } finally {
      spy.mockRestore();
    }
  });
});
