import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
} from "../../../../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";

describe("ProjectRegistryOps", () => {
  let dir: string;
  let realPath: string;
  let ops: ProjectRegistryOps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pro-"));
    realPath = join(dir, "repo");
    mkdirSync(realPath, { recursive: true });
    writeFileSync(join(realPath, ".keep"), "");
    ops = new ProjectRegistryOps({ registry: new CollectionRegistry(dir) });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("register() upserts a name and returns collectionName", async () => {
    const out = await ops.register({ path: realPath, name: "alpha" });
    expect(out.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
    expect(out.alreadyIndexed).toBe(false);
  });

  it("register() throws PathDoesNotExistError on missing path", async () => {
    await expect(ops.register({ path: "/no/such/path", name: "x" })).rejects.toThrow(PathDoesNotExistError);
  });

  it("register() throws ProjectNameInvalidError on bad regex", async () => {
    await expect(ops.register({ path: realPath, name: "BAD NAME" })).rejects.toThrow(ProjectNameInvalidError);
  });

  it("register() throws ProjectNameNotUniqueError on duplicate name", async () => {
    const repo2 = join(dir, "repo2");
    mkdirSync(repo2);
    await ops.register({ path: realPath, name: "shared" });
    await expect(ops.register({ path: repo2, name: "shared" })).rejects.toThrow(ProjectNameNotUniqueError);
  });

  it("list() returns all entries", async () => {
    await ops.register({ path: realPath, name: "alpha" });
    const out = await ops.list();
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].name).toBe("alpha");
  });

  it("unregister() is idempotent (removed=false when missing)", async () => {
    const out1 = await ops.unregister({ name: "nope" });
    expect(out1.removed).toBe(false);
    await ops.register({ path: realPath, name: "alpha" });
    const out2 = await ops.unregister({ name: "alpha" });
    expect(out2.removed).toBe(true);
  });
});
