/**
 * TEA_RAGS_GENERATED_PATTERNS / TEA_RAGS_MINIFIED_LINE_THRESHOLD (bd
 * tea-rags-mcp-82ztq). Parsed by bootstrap config and installed into the file
 * classifier by the composition root; the classifier itself reads no env.
 *
 * Process-owned knobs, not registry-replayed: they are absent from
 * REGISTRY_ENV_GROUPS, as they were before the parse moved here.
 */
import { describe, expect, it } from "vitest";

import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";
import { fileClassificationSchema } from "../../src/bootstrap/config/schemas.js";
import { REGISTRY_ENV_ALLOWLIST } from "../../src/core/domains/maintenance/registry/env-groups.js";
import { DEFAULT_MINIFIED_LINE_LENGTH } from "../../src/core/infra/file-classification/index.js";

describe("fileClassificationSchema", () => {
  it("defaults to no extra generated globs and the 50k threshold", () => {
    expect(fileClassificationSchema.parse({})).toEqual({
      userGeneratedPatterns: [],
      minifiedLineLength: DEFAULT_MINIFIED_LINE_LENGTH,
    });
  });

  it("splits the generated globs on commas, trimming and dropping blanks", () => {
    expect(
      fileClassificationSchema.parse({ userGeneratedPatterns: " **/gen/** ,, *.out.ts ," }).userGeneratedPatterns,
    ).toEqual(["**/gen/**", "*.out.ts"]);
  });

  it("uses a positive integer threshold", () => {
    expect(fileClassificationSchema.parse({ minifiedLineLength: "10" }).minifiedLineLength).toBe(10);
  });

  it.each(["not-a-number", "0", "-5", "", "  "])("falls back to the default threshold for %j", (raw) => {
    expect(fileClassificationSchema.parse({ minifiedLineLength: raw }).minifiedLineLength).toBe(
      DEFAULT_MINIFIED_LINE_LENGTH,
    );
  });
});

describe("parseAppConfigZod — fileClassification", () => {
  it("reads both knobs from the env source", () => {
    const parsed = parseAppConfigZod({
      TEA_RAGS_GENERATED_PATTERNS: "**/gen/**",
      TEA_RAGS_MINIFIED_LINE_THRESHOLD: "123",
    });
    expect(parsed.fileClassification).toEqual({ userGeneratedPatterns: ["**/gen/**"], minifiedLineLength: 123 });
  });

  it("keeps both knobs out of the registry env mechanism", () => {
    expect(REGISTRY_ENV_ALLOWLIST).not.toContain("TEA_RAGS_GENERATED_PATTERNS");
    expect(REGISTRY_ENV_ALLOWLIST).not.toContain("TEA_RAGS_MINIFIED_LINE_THRESHOLD");
  });
});
