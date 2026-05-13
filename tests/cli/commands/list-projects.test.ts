import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listProjectsCommand } from "../../../src/cli/commands/list-projects.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI list-projects", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-lp-"));
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

  it("prints registry entries (tab-separated)", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((m: string) => {
      out.push(String(m));
      return true;
    }) as never);
    await listProjectsCommand.handler({ json: false, _: [], $0: "" } as never);
    spy.mockRestore();
    expect(out.join("")).toMatch(/alpha/);
    expect(out.join("")).toMatch(/code_abc/);
  });

  it("prints JSON when --json is set", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((m: string) => {
      out.push(String(m));
      return true;
    }) as never);
    await listProjectsCommand.handler({ json: true, _: [], $0: "" } as never);
    spy.mockRestore();
    const json = JSON.parse(out.join(""));
    expect(Array.isArray(json)).toBe(true);
    expect(json[0].name).toBe("alpha");
  });

  it("prints placeholder when registry is empty", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "cli-lp-empty-"));
    process.env.TEA_RAGS_DATA_DIR = emptyDir;
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((m: string) => {
      out.push(String(m));
      return true;
    }) as never);
    await listProjectsCommand.handler({ json: false, _: [], $0: "" } as never);
    spy.mockRestore();
    rmSync(emptyDir, { recursive: true, force: true });
    expect(out.join("")).toMatch(/no projects registered/);
  });

  it("builder declares the --json flag with a boolean default", () => {
    // End-to-end yargs option registration: the builder function defines the
    // CLI surface. We capture the call to ensure --json is wired correctly.
    const calls: [string, unknown][] = [];
    const yargsStub = {
      option(name: string, opts: unknown) {
        calls.push([name, opts]);
        return this;
      },
    };
    const builder = listProjectsCommand.builder as (y: typeof yargsStub) => typeof yargsStub;
    builder(yargsStub);
    expect(calls.find(([n]) => n === "json")?.[1]).toMatchObject({ type: "boolean", default: false });
  });
});
