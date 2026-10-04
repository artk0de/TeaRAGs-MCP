/**
 * The `infra/file-classification` facade contract (bd tea-rags-mcp-0qaht.34):
 * everything a consumer reaches past `index.ts` must be reachable THROUGH it.
 * Two consumers imported internals directly (`capability/native.ts` the
 * installer, `infra/scope-detection.ts` the matcher); both must go through the
 * facade, so the boundary guard below scans their sources — a deep import
 * re-appearing turns this red even though every name is already re-exported.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  installTestFileConventions,
  matchesTestFileConventions,
} from "../../../../src/core/infra/file-classification/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Sources of every file with a known file-classification bypass history. */
const FACADE_CONSUMERS = [
  "src/core/domains/language/capability/native.ts",
  "src/core/infra/scope-detection.ts",
] as const;

describe("file-classification facade", () => {
  it("exposes the installer and the matcher consumers need", () => {
    expect(typeof installTestFileConventions).toBe("function");
    expect(typeof matchesTestFileConventions).toBe("function");
  });

  it("matcher answers through the facade once conventions are installed", () => {
    expect(matchesTestFileConventions("src/foo.test.ts")).toBe(true);
    expect(matchesTestFileConventions("src/foo.ts")).toBe(false);
  });

  it("every consumer imports the facade, not an internal module", () => {
    for (const relPath of FACADE_CONSUMERS) {
      const source = readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
      const specs = [...source.matchAll(/from "([^"]*file-classification\/[^"]*)"/g)].map((m) => m[1]);
      expect(specs.length, `${relPath} imports file-classification at least once`).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(
          spec.endsWith("file-classification/index.js"),
          `${relPath} deep-imports "${spec}" past the facade`,
        ).toBe(true);
      }
    }
  });
});
