import { afterEach, describe, expect, it } from "vitest";

import {
  isCompiledJsContent,
  isJsFamilyPath,
  maxLineLength,
} from "../../../../src/core/infra/file-classification/index.js";

describe("maxLineLength", () => {
  it("returns 0 for an empty string", () => {
    expect(maxLineLength("")).toBe(0);
  });

  it("returns the length of a single no-newline line", () => {
    expect(maxLineLength("abcde")).toBe(5);
  });

  it("returns the longest line across LF-separated lines", () => {
    expect(maxLineLength("a\nbbbb\ncc")).toBe(4);
  });

  it("treats CRLF as a line break without inflating by the carriage return", () => {
    expect(maxLineLength("ab\r\ncccc\r\nd")).toBe(4);
  });

  it("counts a long final line that has no trailing newline", () => {
    const code = `short\n${"x".repeat(120)}`;
    expect(maxLineLength(code)).toBe(120);
  });
});

describe("isJsFamilyPath", () => {
  it("matches js/jsx/mjs/cjs/ts/tsx (case-insensitive)", () => {
    for (const p of ["a.js", "a.jsx", "a.mjs", "a.cjs", "a.ts", "a.tsx", "dir/B.TS"]) {
      expect(isJsFamilyPath(p)).toBe(true);
    }
  });

  it("does not match non-JS-family extensions", () => {
    for (const p of ["a.rb", "a.py", "a.go", "a.json", "a.css", "README.md", "noext"]) {
      expect(isJsFamilyPath(p)).toBe(false);
    }
  });
});

describe("isCompiledJsContent", () => {
  it("flags a modern //# sourceMappingURL comment", () => {
    const code = "const x = 1;\n//# sourceMappingURL=app.js.map\n";
    expect(isCompiledJsContent(code)).toBe(true);
  });

  it("flags the legacy //@ sourceMappingURL comment with no trailing newline", () => {
    const code = "const x = 1;\n//@ sourceMappingURL=app.js.map";
    expect(isCompiledJsContent(code)).toBe(true);
  });

  it("flags a minified single-line bundle over the length threshold", () => {
    const code = `var a=${"1+".repeat(60000)}1;`;
    expect(isCompiledJsContent(code)).toBe(true);
  });

  it("does NOT flag normal multi-line source", () => {
    const code = ["export function add(a, b) {", "  // sum two numbers", "  return a + b;", "}"].join("\n");
    expect(isCompiledJsContent(code)).toBe(false);
  });

  it("does NOT match a sourceMappingURL substring embedded mid-line in a string literal", () => {
    const code = 'const note = "see sourceMappingURL= docs"; // not a real marker\n';
    expect(isCompiledJsContent(code)).toBe(false);
  });
});

describe("isCompiledJsContent — threshold env override", () => {
  const ENV = "TEA_RAGS_MINIFIED_LINE_THRESHOLD";
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("uses a lowered threshold supplied via the env var", () => {
    process.env[ENV] = "10";
    // A 20-char single line is far below the 50k default but above 10.
    expect(isCompiledJsContent("12345678901234567890")).toBe(true);
  });

  it("falls back to the default threshold when the env value is not a valid number", () => {
    process.env[ENV] = "not-a-number";
    expect(isCompiledJsContent("12345678901234567890")).toBe(false);
  });

  it("ignores a non-positive env value and keeps the default threshold", () => {
    process.env[ENV] = "0";
    expect(isCompiledJsContent("12345678901234567890")).toBe(false);
  });
});
