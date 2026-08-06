import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { unavailable } from "../../../src/cli/update-check/types.js";
import { CollectionRegistry, resolveCollectionName } from "../../../src/core/api/public/index.js";

const { pingMock, createAppContextMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({
  pingQdrant: pingMock,
}));

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: createAppContextMock,
}));

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: () => ({}),
  getZodConfig: () => ({ deprecations: [] }),
}));

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  writeMock.mockClear();
  pingMock.mockReset();
  createAppContextMock.mockReset();
  process.stdout.write = writeMock as unknown as typeof process.stdout.write;
  dataDir = mkdtempSync(join(tmpdir(), "prime-auto-update-"));
  prevDataDir = process.env.TEA_RAGS_DATA_DIR;
  process.env.TEA_RAGS_DATA_DIR = dataDir;
});

afterEach(() => {
  process.stdout.write = stdoutOriginal;
  if (prevDataDir === undefined) delete process.env.TEA_RAGS_DATA_DIR;
  else process.env.TEA_RAGS_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function stubUpdateService(): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
}

describe("runPrime — auto-update trigger wiring", () => {
  it("fires maybeSpawn once with the resolved collectionName and renders its outcome", async () => {
    const path = process.cwd();
    const collectionName = resolveCollectionName(path);
    const registry = new CollectionRegistry(dataDir);
    registry.record({
      collectionName,
      path,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-08-06T00:00:00.000Z",
      teaRagsVersion: "1.0.0",
      chunksCount: 10,
    });
    registry.setName(collectionName, "auto-upd-proj");
    registry.setAutoUpdate(collectionName, { enabled: true, targetBranch: "master" });

    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName,
          chunksCount: 100,
          lastUpdated: new Date(),
        }),
        getIndexMetrics: vi.fn().mockResolvedValue(null),
        checkSchemaDrift: vi.fn().mockResolvedValue("none"),
      },
      cleanup: vi.fn(),
      updateService: stubUpdateService(),
    });

    const maybeSpawn = vi.fn().mockReturnValue("eligible");
    await runPrime({ project: "auto-upd-proj", autoUpdateTrigger: { maybeSpawn } });

    expect(maybeSpawn).toHaveBeenCalledTimes(1);
    expect(maybeSpawn).toHaveBeenCalledWith(collectionName);
    const output = writeMock.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("auto-update: on (master) · catching up in background");
  });
});
