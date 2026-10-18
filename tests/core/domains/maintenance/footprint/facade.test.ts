/**
 * The `domains/maintenance/footprint` facade contract (bd
 * tea-rags-mcp-0qaht.34): `WorktreeProvisioner` used to import the clone saga
 * from this domain; since the `CollectionFootprintPort` seam (bd
 * tea-rags-mcp-54xwd.2) the provisioner reaches the footprint through the
 * contracts port and imports this domain NEVER. The boundary guard scans the
 * provisioner's source — any footprint import re-appearing turns this red.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cloneCollectionFootprint as directCloneCollectionFootprint } from "../../../../../src/core/domains/maintenance/footprint/clone-saga.js";
import { cloneCollectionFootprint } from "../../../../../src/core/domains/maintenance/footprint/index.js";

const PROVISIONER_PATH = fileURLToPath(
  new URL("../../../../../src/core/domains/maintenance/worktree/worktree-provisioner.ts", import.meta.url),
);

describe("footprint facade", () => {
  it("exposes the clone saga the worktree seed path needs", () => {
    expect(typeof cloneCollectionFootprint).toBe("function");
  });

  it("re-exports the saga itself, not a wrapper", () => {
    expect(cloneCollectionFootprint).toBe(directCloneCollectionFootprint);
  });

  it("the worktree provisioner does not import this domain at all — the contracts port replaced the edge", () => {
    const source = readFileSync(PROVISIONER_PATH, "utf8");
    const specs = [...source.matchAll(/from "([^"]*footprint\/[^"]*)"/g)].map((m) => m[1]);
    expect(specs, "worktree-provisioner must depend on CollectionFootprintPort, not on footprint").toEqual([]);
  });
});
