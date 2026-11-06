import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnDetachedUpdater } from "../../../src/bootstrap/auto-update/spawner.js";
import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { spawnDetachedClientUpdate } from "../../../src/cli/client-update/spawner.js";
import { runPrime } from "../../../src/cli/prime/run-prime.js";
import { upToDate } from "../../../src/cli/update-check/types.js";
import { CollectionRegistry, IndexFreshnessCheck } from "../../../src/core/api/index.js";

vi.mock("../../../src/bootstrap/config/index.js", () => ({ parseAppConfig: () => ({}) }));
vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({ pingQdrant: async () => true }));
vi.mock("../../../src/bootstrap/auto-update/spawner.js", () => ({ spawnDetachedUpdater: vi.fn() }));
vi.mock("../../../src/cli/client-update/spawner.js", () => ({ spawnDetachedClientUpdate: vi.fn() }));
let dir: string;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("prime default update triggers", () => {
  it("schedules eligible index and client updates, closes the session and retains the digest", async () => {
    dir = mkdtempSync(join(tmpdir(), "prime-default-triggers-"));
    vi.stubEnv("TEA_RAGS_DATA_DIR", dir);
    vi.stubEnv("TEA_RAGS_AUTO_UPDATE", "1");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const registry = new CollectionRegistry(dir);
    registry.record({
      collectionName: "code_proj",
      path: dir,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-11-06T00:00:00Z",
      teaRagsVersion: "1.50.0",
      chunksCount: 1,
    });
    registry.setName("code_proj", "proj");
    const entry = registry.get("code_proj")!;
    vi.spyOn(IndexFreshnessCheck.prototype, "check").mockReturnValue({ kind: "eligible", entry });
    const session: InProcessToolSession = {
      listTools: vi.fn(),
      callTool: vi.fn(),
      listResources: vi.fn(),
      listResourceTemplates: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      readResource: vi.fn(async (uri) => ({
        contents: [{ uri, mimeType: "text/markdown", text: "# project digest\n" }],
      })),
    };
    await runPrime({
      project: "proj",
      createPathCollectionResolver: vi.fn(),
      registryRuntime: {
        openRegistry: () => registry,
        createFreshness: () => new IndexFreshnessCheck(),
        externalQdrantUrlOf: () => "http://localhost:6333",
        replayEntryEnv: () => undefined,
      },
      openSession: async () => session,
      updateService: { checkForUpdate: async () => upToDate("1.50.0") },
    });
    expect(spawnDetachedClientUpdate).toHaveBeenCalledWith({ dataDir: dir });
    expect(spawnDetachedUpdater).toHaveBeenCalledWith({ project: "code_proj", logFd: expect.any(Number) });
    expect(existsSync(join(dir, "logs", "auto-update-proj.log"))).toBe(true);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(out.mock.calls.map(([text]) => String(text)).join("")).toContain("# project digest");
  });
});
