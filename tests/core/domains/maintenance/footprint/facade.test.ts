/**
 * The `domains/maintenance/footprint` facade contract (bd
 * tea-rags-mcp-0qaht.34): `WorktreeProvisioner` imported the clone saga past
 * `index.ts`; the facade must own that surface and the provisioner must reach
 * it only there. The boundary guard scans the provisioner's source — a deep
 * import re-appearing turns this red even though `export *` already covers the
 * name.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cloneCollectionFootprint } from "../../../../../src/core/domains/maintenance/footprint/index.js";
import { cloneCollectionFootprint as directCloneCollectionFootprint } from "../../../../../src/core/domains/maintenance/footprint/clone-saga.js";

const PROVISIONER_PATH =
  fileURLToPath(new URL("../../../../../src/core/domains/maintenance/worktree/worktree-provisioner.ts", import.meta.url));

describe("footprint facade", () => {
  it("exposes the clone saga the worktree provisioner needs", () => {
    expect(typeof cloneCollectionFootprint).toBe("function");
  });

  it("re-exports the saga itself, not a wrapper", () => {
    expect(cloneCollectionFootprint).toBe(directCloneCollectionFootprint);
  });

  it("the worktree provisioner imports the facade, not an internal module", () => {
    const source = readFileSync(PROVISIONER_PATH, "utf8");
    const specs = [...source.matchAll(/from "([^"]*footprint\/[^"]*)"/g)].map((m) => m[1]);
    expect(specs.length, "worktree-provisioner imports footprint at least once").toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.endsWith("footprint/index.js"), `deep-import "${spec}" past the facade`).toBe(true);
    }
  });
});
