import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";

/**
 * `FileScanner#accepts` is the one ingest admission rule (bd tea-rags-mcp-xi2r9.2):
 * the working-tree overlay asks it about single repo-relative paths, and
 * `scanDirectory` admits exactly the files it accepts.
 */
describe("FileScanner#accepts", () => {
  let root: string;
  let scanner: FileScanner;

  const write = (relativePath: string, content = "export const x = 1;\n"): void => {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "scanner-accepts-"));
    write(".contextignore", "generated/\n");
    write(".gitignore", "secret.ts\n");
    scanner = new FileScanner({ supportedExtensions: [".ts"], ignorePatterns: [] });
    await scanner.loadIgnorePatterns(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("should accept a supported source file", () => {
    expect(scanner.accepts("src/app.ts")).toBe(true);
  });

  it("should reject an unsupported extension", () => {
    expect(scanner.accepts("assets/logo.png")).toBe(false);
  });

  it("should reject a file under node_modules", () => {
    expect(scanner.accepts("node_modules/x.ts")).toBe(false);
  });

  it("should reject a file under a .contextignore'd directory", () => {
    expect(scanner.accepts("generated/deep/model.ts")).toBe(false);
  });

  it("should reject a .gitignore'd file", () => {
    expect(scanner.accepts("secret.ts")).toBe(false);
  });

  it("should admit through scanDirectory exactly the files it accepts", async () => {
    const candidates = ["src/app.ts", "assets/logo.png", "node_modules/x.ts", "generated/deep/model.ts", "secret.ts"];
    for (const candidate of candidates) write(candidate);

    const scanned = (await scanner.scanDirectory(root)).map((file) => file.slice(root.length + 1)).sort();

    expect(scanned).toEqual(candidates.filter((candidate) => scanner.accepts(candidate)).sort());
    expect(scanned).toEqual(["src/app.ts"]);
  });
});
