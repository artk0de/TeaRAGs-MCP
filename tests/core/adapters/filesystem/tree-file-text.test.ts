/**
 * One working-tree file's text by repo-relative path (bd tea-rags-mcp-r8hme.52.19):
 * the architecture report reads the path literals of development roots from it.
 * Total — anything it cannot or should not read answers `undefined`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTreeFileText } from "../../../../src/core/adapters/filesystem/tree-file-text.js";

describe("readTreeFileText", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tree-file-text-"));
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "vite.prototypes.config.ts"), "resolve(ROOT, 'app/prototypes');");
    writeFileSync(join(root, "app", "huge.ts"), "x".repeat(300 * 1024));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a file under the root by its relative path", () => {
    expect(readTreeFileText(root, "vite.prototypes.config.ts")).toBe("resolve(ROOT, 'app/prototypes');");
  });

  it("answers undefined for a missing file, a directory, an oversized file and a path escaping the root", () => {
    expect(readTreeFileText(root, "missing.ts")).toBeUndefined();
    expect(readTreeFileText(root, "app")).toBeUndefined();
    expect(readTreeFileText(root, "app/huge.ts")).toBeUndefined();
    expect(readTreeFileText(root, "../outside.ts")).toBeUndefined();
  });
});
