import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unregisterProjectCommand } from "../../../src/cli/commands/unregister-project.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI unregister-project", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-up-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    const r = new CollectionRegistry(dir);
    r.record({
      collectionName: "code_abc",
      path: "/repo",
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 1,
    });
    r.setName("code_abc", "alpha");
  });
  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the entry by name and reports it", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((m: string) => {
      out.push(String(m));
      return true;
    }) as never);
    await unregisterProjectCommand.handler({ name: "alpha", _: [], $0: "" } as never);
    spy.mockRestore();
    const r = new CollectionRegistry(dir);
    expect(r.findByName("alpha")).toBeNull();
    expect(out.join("")).toMatch(/Removed 'alpha'/);
  });

  it("is idempotent — reports unknown name without throwing", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((m: string) => {
      out.push(String(m));
      return true;
    }) as never);
    await unregisterProjectCommand.handler({ name: "ghost", _: [], $0: "" } as never);
    spy.mockRestore();
    expect(out.join("")).toMatch(/'ghost' was not registered/);
  });
});
