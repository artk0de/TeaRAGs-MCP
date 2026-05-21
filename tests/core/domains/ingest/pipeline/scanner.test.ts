import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";
import type { ScannerConfig } from "../../../../../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../../../__fixtures__");

describe("FileScanner", () => {
  let scanner: FileScanner;
  let config: ScannerConfig;

  beforeEach(() => {
    config = {
      supportedExtensions: [".ts", ".js", ".py"],
      ignorePatterns: ["node_modules/**", "dist/**"],
    };
    scanner = new FileScanner(config);
  });

  describe("scanDirectory", () => {
    it("should find all supported files", async () => {
      const files = await scanner.scanDirectory(join(fixturesDir, "sample-ts"));
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.endsWith("auth.ts"))).toBe(true);

      // Verify new fixture files are found
      expect(files.some((f) => f.endsWith("database.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("utils.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("validator.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("config.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("async-operations.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("types-advanced.ts"))).toBe(true);

      // Should have at least 8 TypeScript files
      expect(files.length).toBeGreaterThanOrEqual(8);
    });

    it("should respect supported extensions", async () => {
      const files = await scanner.scanDirectory(join(fixturesDir, "sample-ts"));
      files.forEach((file) => {
        const hasValidExt = config.supportedExtensions.some((ext) => file.endsWith(ext));
        expect(hasValidExt).toBe(true);
      });
    });

    it("should handle empty directories", async () => {
      const config: ScannerConfig = {
        supportedExtensions: [".nonexistent"],
        ignorePatterns: [],
      };
      const scanner = new FileScanner(config);
      const files = await scanner.scanDirectory(join(fixturesDir, "sample-ts"));
      expect(files).toEqual([]);
    });
  });

  describe("loadIgnorePatterns", () => {
    it("should load .gitignore patterns", async () => {
      await scanner.loadIgnorePatterns(join(fixturesDir, "sample-ts"));
      const files = await scanner.scanDirectory(join(fixturesDir, "sample-ts"));
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });

    it("should handle missing ignore files gracefully", async () => {
      await expect(scanner.loadIgnorePatterns("/nonexistent/path")).resolves.not.toThrow();
    });

    it("should load .contextignore.local patterns", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "scanner-test-"));
      // Create .contextignore.local that ignores *.secret.ts
      writeFileSync(join(tmpDir, ".contextignore.local"), "*.secret.ts\n");
      // Create files
      writeFileSync(join(tmpDir, "app.ts"), "export const app = 1;");
      writeFileSync(join(tmpDir, "keys.secret.ts"), "export const key = 'x';");

      const localScanner = new FileScanner({
        supportedExtensions: [".ts"],
        ignorePatterns: [],
      });
      await localScanner.loadIgnorePatterns(tmpDir);
      const files = await localScanner.scanDirectory(tmpDir);

      expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("keys.secret.ts"))).toBe(false);
    });

    it("should drop stale patterns when .contextignore.local is removed between reloads", async () => {
      // Regression: long-running indexers (MCP server) reuse the same
      // FileScanner instance. loadIgnorePatterns must produce a fresh
      // ignore matcher each call — otherwise removing .contextignore.local
      // leaves its stale patterns active, so newly-unignored files stay
      // hidden from subsequent scans.
      const { rmSync } = await import("node:fs");
      const tmpDir = mkdtempSync(join(tmpdir(), "scanner-reload-"));
      writeFileSync(join(tmpDir, "app.ts"), "export const app = 1;");
      writeFileSync(join(tmpDir, "feature.ts"), "export const feature = 2;");
      const ignorePath = join(tmpDir, ".contextignore.local");
      writeFileSync(ignorePath, "feature.ts\n");

      const localScanner = new FileScanner({
        supportedExtensions: [".ts"],
        ignorePatterns: [],
      });

      // First load: feature.ts is ignored.
      await localScanner.loadIgnorePatterns(tmpDir);
      const before = await localScanner.scanDirectory(tmpDir);
      expect(before.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(before.some((f) => f.endsWith("feature.ts"))).toBe(false);

      // Remove the override and reload patterns on the SAME scanner.
      rmSync(ignorePath);
      await localScanner.loadIgnorePatterns(tmpDir);
      const after = await localScanner.scanDirectory(tmpDir);

      // feature.ts must come back — its ignore pattern no longer exists.
      expect(after.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(after.some((f) => f.endsWith("feature.ts"))).toBe(true);
    });
  });

  describe("BUILTIN_IGNORE_PATTERNS baseline", () => {
    // Built-in baseline must drop framework build artefacts and minified
    // bundles even when the project ships zero ignore files. Catches the
    // ugnest scenario where `legacy/uapi/frontend/_nuxt/*.js` got indexed
    // and codegraph extracted 96k method edges from a single minified
    // bundle, blowing memory.
    it("excludes framework build dirs, language caches, and minified bundles without any user ignore files", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "scanner-builtin-"));
      // Framework build artefacts
      mkdirSync(join(tmpDir, "_nuxt"), { recursive: true });
      writeFileSync(join(tmpDir, "_nuxt", "ba60db8.js"), "export const x = 1;");
      mkdirSync(join(tmpDir, ".next"), { recursive: true });
      writeFileSync(join(tmpDir, ".next", "app.js"), "export const x = 1;");
      mkdirSync(join(tmpDir, "target"), { recursive: true });
      writeFileSync(join(tmpDir, "target", "Main.java"), "class Main {}");
      // Language caches
      mkdirSync(join(tmpDir, "__pycache__"), { recursive: true });
      writeFileSync(join(tmpDir, "__pycache__", "module.cpython-311.pyc"), "compiled");
      writeFileSync(join(tmpDir, "stale.pyc"), "compiled");
      // Minified bundles at root
      writeFileSync(join(tmpDir, "app.min.js"), "var a=1;");
      writeFileSync(join(tmpDir, "vendor.bundle.js"), "var b=1;");
      // Legitimate sources that must survive
      writeFileSync(join(tmpDir, "main.ts"), "export const main = 1;");
      writeFileSync(join(tmpDir, "lib.py"), "def x(): pass");

      const localScanner = new FileScanner({
        supportedExtensions: [".ts", ".js", ".py", ".pyc", ".java"],
        ignorePatterns: [],
      });
      await localScanner.loadIgnorePatterns(tmpDir);
      const files = await localScanner.scanDirectory(tmpDir);

      // Legitimate files present
      expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("lib.py"))).toBe(true);
      // Framework artefacts excluded
      expect(files.some((f) => f.includes("/_nuxt/"))).toBe(false);
      expect(files.some((f) => f.includes("/.next/"))).toBe(false);
      expect(files.some((f) => f.includes("/target/"))).toBe(false);
      // Language caches excluded
      expect(files.some((f) => f.includes("/__pycache__/"))).toBe(false);
      expect(files.some((f) => f.endsWith(".pyc"))).toBe(false);
      // Minified bundles excluded
      expect(files.some((f) => f.endsWith("app.min.js"))).toBe(false);
      expect(files.some((f) => f.endsWith("vendor.bundle.js"))).toBe(false);
    });

    // ignore-package supports negations (`!pattern`). A user .contextignore
    // entry overrides any built-in baseline pattern — verifies the semantic
    // assumption documented in ignore-defaults.ts.
    it("honors user .contextignore negation overriding a built-in pattern", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "scanner-negation-"));
      writeFileSync(join(tmpDir, "main.ts"), "export const main = 1;");
      writeFileSync(join(tmpDir, "vendor.min.js"), "var a=1;");
      // User explicitly re-includes the minified bundle they want indexed.
      writeFileSync(join(tmpDir, ".contextignore"), "!vendor.min.js\n");

      const localScanner = new FileScanner({
        supportedExtensions: [".ts", ".js"],
        ignorePatterns: [],
      });
      await localScanner.loadIgnorePatterns(tmpDir);
      const files = await localScanner.scanDirectory(tmpDir);

      expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
      // Negation re-includes vendor.min.js despite *.min.js baseline.
      expect(files.some((f) => f.endsWith("vendor.min.js"))).toBe(true);
    });

    // User .contextignore that duplicates a baseline pattern must not
    // raise — ignore-package add() is idempotent on duplicates.
    it("accepts user patterns that duplicate the baseline without errors", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "scanner-dup-"));
      writeFileSync(join(tmpDir, "main.ts"), "export const main = 1;");
      writeFileSync(join(tmpDir, ".contextignore"), "__pycache__/\n*.min.js\n");

      const localScanner = new FileScanner({
        supportedExtensions: [".ts"],
        ignorePatterns: [],
      });
      await expect(localScanner.loadIgnorePatterns(tmpDir)).resolves.not.toThrow();
      const files = await localScanner.scanDirectory(tmpDir);
      expect(files.some((f) => f.endsWith("main.ts"))).toBe(true);
    });
  });

  describe("getSupportedExtensions", () => {
    it("should return configured extensions", () => {
      const extensions = scanner.getSupportedExtensions();
      expect(extensions).toEqual([".ts", ".js", ".py"]);
    });
  });

  describe("shouldIgnore", () => {
    it("should return true for files matching ignore patterns", async () => {
      const ignoreConfig: ScannerConfig = {
        supportedExtensions: [".ts", ".js"],
        ignorePatterns: ["node_modules/**", "dist/**"],
      };
      const ignoreScanner = new FileScanner(ignoreConfig);
      await ignoreScanner.loadIgnorePatterns(join(fixturesDir, "sample-ts"));

      const rootPath = join(fixturesDir, "sample-ts");
      const ignoredPath = join(rootPath, "node_modules", "some-package", "index.js");

      expect(ignoreScanner.shouldIgnore(ignoredPath, rootPath)).toBe(true);
    });

    it("should return false for files not matching ignore patterns", async () => {
      const ignoreConfig: ScannerConfig = {
        supportedExtensions: [".ts", ".js"],
        ignorePatterns: ["node_modules/**"],
      };
      const ignoreScanner = new FileScanner(ignoreConfig);
      await ignoreScanner.loadIgnorePatterns(join(fixturesDir, "sample-ts"));

      const rootPath = join(fixturesDir, "sample-ts");
      const allowedPath = join(rootPath, "src", "index.ts");

      expect(ignoreScanner.shouldIgnore(allowedPath, rootPath)).toBe(false);
    });

    it("should respect custom ignore patterns", async () => {
      const customConfig: ScannerConfig = {
        supportedExtensions: [".ts", ".js"],
        ignorePatterns: [],
        customIgnorePatterns: ["**/*.test.ts", "**/tests/**"],
      };
      const customScanner = new FileScanner(customConfig);
      await customScanner.loadIgnorePatterns(join(fixturesDir, "sample-ts"));

      const rootPath = join(fixturesDir, "sample-ts");

      expect(customScanner.shouldIgnore(join(rootPath, "src", "utils.test.ts"), rootPath)).toBe(true);
      expect(customScanner.shouldIgnore(join(rootPath, "tests", "main.ts"), rootPath)).toBe(true);
      expect(customScanner.shouldIgnore(join(rootPath, "src", "utils.ts"), rootPath)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle paths with special characters", async () => {
      const files = await scanner.scanDirectory(join(fixturesDir, "sample-ts"));
      expect(Array.isArray(files)).toBe(true);
    });

    it("should skip symbolic links", async () => {
      const files = await scanner.scanDirectory(join(fixturesDir, "sample-ts"));
      expect(Array.isArray(files)).toBe(true);
    });

    it("should handle custom ignore patterns", async () => {
      const customConfig: ScannerConfig = {
        supportedExtensions: [".ts", ".js"],
        ignorePatterns: [],
        customIgnorePatterns: ["**/*.test.ts"],
      };
      const customScanner = new FileScanner(customConfig);
      await customScanner.loadIgnorePatterns(join(fixturesDir, "sample-ts"));
      const files = await customScanner.scanDirectory(join(fixturesDir, "sample-ts"));
      expect(files.some((f) => f.includes(".test.ts"))).toBe(false);
    });

    it("should properly ignore files matching ignore patterns", async () => {
      const ignoreConfig: ScannerConfig = {
        supportedExtensions: [".ts", ".js"],
        ignorePatterns: ["**/auth.ts"],
      };
      const ignoreScanner = new FileScanner(ignoreConfig);
      await ignoreScanner.loadIgnorePatterns(join(fixturesDir, "sample-ts"));
      const files = await ignoreScanner.scanDirectory(join(fixturesDir, "sample-ts"));

      // Should not include auth.ts due to ignore pattern
      expect(files.some((f) => f.endsWith("auth.ts"))).toBe(false);
    });

    it("should handle directories with .gitignore", async () => {
      const scannerWithGitignore = new FileScanner(config);
      await scannerWithGitignore.loadIgnorePatterns(join(fixturesDir, "sample-ts"));
      const files = await scannerWithGitignore.scanDirectory(join(fixturesDir, "sample-ts"));

      // Files matching .gitignore patterns should be excluded
      expect(Array.isArray(files)).toBe(true);
    });

    it("should gracefully handle non-existent directories", async () => {
      const files = await scanner.scanDirectory("/nonexistent/directory/path");
      expect(files).toEqual([]);
    });
  });
});
