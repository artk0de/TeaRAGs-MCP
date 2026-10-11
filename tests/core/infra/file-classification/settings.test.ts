/**
 * The file classifier's two operator knobs — extra generated globs and the
 * minified-line threshold — reach it by injection from the composition root,
 * never from `process.env` (bd tea-rags-mcp-82ztq).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  classify,
  DEFAULT_FILE_CLASSIFICATION_SETTINGS,
  DEFAULT_MINIFIED_LINE_LENGTH,
  installedFileClassificationSettings,
  installFileClassificationSettings,
  isCompiledJsContent,
} from "../../../../src/core/infra/file-classification/index.js";

const TWENTY_CHARS = "12345678901234567890";

describe("file-classification settings — injection", () => {
  afterEach(() => {
    installFileClassificationSettings(DEFAULT_FILE_CLASSIFICATION_SETTINGS);
  });

  it("defaults to no extra generated globs and the 50k minified-line threshold", () => {
    expect(DEFAULT_FILE_CLASSIFICATION_SETTINGS).toEqual({
      userGeneratedPatterns: [],
      minifiedLineLength: DEFAULT_MINIFIED_LINE_LENGTH,
    });
    expect(installedFileClassificationSettings()).toEqual(DEFAULT_FILE_CLASSIFICATION_SETTINGS);
  });

  it("isCompiledJsContent honours an explicit threshold argument", () => {
    expect(isCompiledJsContent(TWENTY_CHARS, 10)).toBe(true);
    expect(isCompiledJsContent(TWENTY_CHARS, 20)).toBe(false);
  });

  it("isCompiledJsContent answers from the installed threshold when none is passed", () => {
    expect(isCompiledJsContent(TWENTY_CHARS)).toBe(false);
    installFileClassificationSettings({ ...DEFAULT_FILE_CLASSIFICATION_SETTINGS, minifiedLineLength: 10 });
    expect(isCompiledJsContent(TWENTY_CHARS)).toBe(true);
  });

  it("classify flags a path matching an installed user generated glob", () => {
    expect(classify("src/gen/client.ts").isGenerated).toBe(false);
    installFileClassificationSettings({
      ...DEFAULT_FILE_CLASSIFICATION_SETTINGS,
      userGeneratedPatterns: ["**/gen/**"],
    });
    expect(classify("src/gen/client.ts").isGenerated).toBe(true);
    installFileClassificationSettings(DEFAULT_FILE_CLASSIFICATION_SETTINGS);
    expect(classify("src/gen/client.ts").isGenerated).toBe(false);
  });

  it("does not read the operator env vars itself", () => {
    const keys = ["TEA_RAGS_MINIFIED_LINE_THRESHOLD", "TEA_RAGS_GENERATED_PATTERNS"] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.TEA_RAGS_MINIFIED_LINE_THRESHOLD = "10";
    process.env.TEA_RAGS_GENERATED_PATTERNS = "**/gen/**";
    try {
      expect(isCompiledJsContent(TWENTY_CHARS)).toBe(false);
      expect(classify("src/gen/client.ts").isGenerated).toBe(false);
    } finally {
      keys.forEach((k, i) => {
        const v = saved[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });
});
