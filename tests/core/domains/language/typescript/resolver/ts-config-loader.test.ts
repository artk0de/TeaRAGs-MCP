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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    expect(result.baseUrl).toBe("./src");
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
    expect(result.baseUrl).toBe("./app");
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
    expect(result.baseUrl).toBe("./src");
    expect(result.paths).toEqual({});
  });
});
