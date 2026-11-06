import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnDetachedClientUpdate } from "../../../src/cli/client-update/spawner.js";
import { runPrimeAgent, runPrimeAgentArgv } from "../../../src/cli/commands/prime-agent.js";
import { CollectionRegistry } from "../../../src/core/api/index.js";

vi.mock("../../../src/cli/client-update/spawner.js", () => ({ spawnDetachedClientUpdate: vi.fn() }));
let dataDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("prime agent default dependencies", () => {
  it("resolves a registered project and evaluates its index-update policy", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "prime-agent-registered-"));
    vi.stubEnv("TEA_RAGS_DATA_DIR", dataDir);
    vi.stubEnv("TEA_RAGS_AUTO_UPDATE", "0");
    const registry = new CollectionRegistry(dataDir);
    registry.record({
      collectionName: "code_proj",
      path: dataDir,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-11-06T00:00:00Z",
      teaRagsVersion: "1.50.0",
      chunksCount: 1,
    });
    registry.setName("code_proj", "proj");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runPrimeAgent({ project: "proj" })).toBe(0);
    expect(out.mock.calls.map(([text]) => String(text)).join("")).toContain("project `proj` · collection `code_proj`");
  });
  it("can schedule a client check while preserving an unregistered project's address error", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "prime-agent-defaults-"));
    vi.stubEnv("TEA_RAGS_DATA_DIR", dataDir);
    vi.stubEnv("TEA_RAGS_AUTO_UPDATE", "1");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runPrimeAgent({ project: "unknown" })).toBe(0);
    expect(spawnDetachedClientUpdate).toHaveBeenCalledWith({ dataDir });
    expect(out.mock.calls.map(([text]) => String(text)).join("")).toContain("project 'unknown' not registered");
  });

  it.each([{ argv: ["--agent", "one", "two"] }, { argv: ["--agent", "--unknown"] }, { argv: ["one"] }])(
    "rejects invalid agent arguments without constructing dependencies: $argv",
    async ({ argv }) => {
      vi.mocked(spawnDetachedClientUpdate).mockClear();
      expect(await runPrimeAgentArgv(argv)).toBe(2);
      expect(spawnDetachedClientUpdate).not.toHaveBeenCalled();
    },
  );
});
