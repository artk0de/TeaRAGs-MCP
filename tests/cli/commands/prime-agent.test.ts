import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrimeAgent, runPrimeAgentArgv, type PrimeAgentDeps } from "../../../src/cli/commands/prime-agent.js";

const entry = {
  collectionName: "code_original",
  name: "proj",
  path: "/repo/base",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "embedded",
  indexedAt: "2000-01-01",
  teaRagsVersion: "1",
  chunksCount: 4,
};
let out: string;
const deps = (): PrimeAgentDeps => ({
  resolveProject: vi.fn(() => ({ entry, path: "/repo/linked" })),
  clientUpdate: { maybeSpawn: vi.fn(), manualUpdateHint: () => null },
  autoUpdate: vi.fn(() => "disabled" as const),
});
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("lean agent prime", () => {
  it("prints known registry addressing with explicit unconfirmed freshness, never a fabricated current state", async () => {
    const d = deps();
    await expect(runPrimeAgent({ path: "/repo/linked" }, d)).resolves.toBe(0);
    expect(out).toContain("project `proj` · collection `code_original`");
    expect(out).toContain("readiness and freshness unconfirmed");
    expect(out).not.toMatch(/warm-up|not indexed|index behind|fresh index/);
    expect(d.resolveProject).toHaveBeenCalledWith({ path: "/repo/linked" });
    expect(d.autoUpdate).toHaveBeenCalledWith(entry);
    expect(d.clientUpdate.maybeSpawn).toHaveBeenCalledTimes(1);
  });

  it("keeps refused client-update and branch-mismatch index-update hints", async () => {
    const d = deps();
    const enabled = { ...entry, autoUpdate: { enabled: true, targetBranch: "main" } };
    d.resolveProject = () => ({ entry: enabled, path: "/repo/linked" });
    d.clientUpdate.manualUpdateHint = () => "run `tea-rags update` by hand";
    d.autoUpdate = () => "branch-mismatch";
    await runPrimeAgent({ path: "/repo/linked" }, d);
    expect(out).toContain("auto-update: paused");
    expect(out).toContain("target main");
    expect(out).toContain("tea-rags client: run `tea-rags update` by hand");
  });

  it("does not fall back from an explicitly unknown project to cwd", async () => {
    const d = deps();
    d.resolveProject = vi.fn(() => null);
    await runPrimeAgent({ project: "missing" }, d);
    expect(d.resolveProject).toHaveBeenCalledWith({ project: "missing" });
    expect(out).toContain("project 'missing' not registered");
    expect(out).not.toContain("code_original");
  });

  it("parses the actual --agent path/project spelling without a yargs command table", async () => {
    const d = deps();
    await expect(runPrimeAgentArgv(["--agent", "/repo/linked", "--project", "proj"], d)).resolves.toBe(0);
    expect(d.resolveProject).toHaveBeenCalledWith({ path: "/repo/linked", project: "proj" });
  });
});
