import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateHomeDir } from "../../../src/bootstrap/migrate.js";

describe("migrateHomeDir", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tea-rags-migrate-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("does nothing when neither directory exists", () => {
    migrateHomeDir(tempHome);
    expect(existsSync(join(tempHome, ".tea-rags"))).toBe(false);
  });

  it("keeps .tea-rags if it already exists", () => {
    const newDir = join(tempHome, ".tea-rags");
    mkdirSync(newDir);
    writeFileSync(join(newDir, "marker"), "new");

    migrateHomeDir(tempHome);
    expect(readFileSync(join(newDir, "marker"), "utf-8")).toBe("new");
  });

  it("renames .tea-rags-mcp to .tea-rags when only old exists", () => {
    const oldDir = join(tempHome, ".tea-rags-mcp");
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "data.json"), '{"test":1}');

    migrateHomeDir(tempHome);

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(tempHome, ".tea-rags"))).toBe(true);
    expect(readFileSync(join(tempHome, ".tea-rags", "data.json"), "utf-8")).toBe('{"test":1}');
  });

  it("does not overwrite .tea-rags if both exist", () => {
    const oldDir = join(tempHome, ".tea-rags-mcp");
    const newDir = join(tempHome, ".tea-rags");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, "old"), "old-data");
    writeFileSync(join(newDir, "new"), "new-data");

    migrateHomeDir(tempHome);

    // New dir preserved, old dir untouched
    expect(readFileSync(join(newDir, "new"), "utf-8")).toBe("new-data");
    expect(existsSync(oldDir)).toBe(true);
  });
});
