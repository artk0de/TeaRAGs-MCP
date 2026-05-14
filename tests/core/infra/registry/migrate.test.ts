import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistryFileCorruptedError } from "../../../../src/core/adapters/registry/errors.js";
import { loadRegistryFile } from "../../../../src/core/infra/registry/registry-file.js";

describe("registry migration framework (audit #10)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regmig-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns V1 as-is when version matches CURRENT_VERSION", () => {
    writeFileSync(
      join(dir, "registry.json"),
      JSON.stringify({
        version: 1,
        collections: {
          code_abc: {
            collectionName: "code_abc",
            path: "/x",
            name: null,
            embeddingModel: "m",
            embeddingDimensions: 1,
            qdrantUrl: "http://q",
            indexedAt: "",
            teaRagsVersion: "",
            chunksCount: 0,
          },
        },
      }),
      "utf-8",
    );
    const result = loadRegistryFile(dir);
    expect(result?.version).toBe(1);
    expect(Object.keys(result?.collections ?? {})).toContain("code_abc");
  });
});

describe("registry corrupt-file backup (audit #3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regcrp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames the file to *.corrupt-<ISO>.bak before throwing on JSON parse failure", () => {
    writeFileSync(join(dir, "registry.json"), "{not-json", "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
    const files = readdirSync(dir);
    const backup = files.find((f: string) => f.startsWith("registry.json.corrupt-") && f.endsWith(".bak"));
    expect(backup).toBeDefined();
    expect(existsSync(join(dir, "registry.json"))).toBe(false);
  });

  it("renames the file before throwing on unknown version", () => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 99, collections: {} }), "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
    const files = readdirSync(dir);
    expect(files.some((f: string) => f.startsWith("registry.json.corrupt-"))).toBe(true);
  });

  it("renames the file when root is not an object", () => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify([1, 2, 3]), "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
    const files = readdirSync(dir);
    expect(files.some((f: string) => f.startsWith("registry.json.corrupt-"))).toBe(true);
  });
});
