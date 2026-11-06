import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAppConfig } from "../../../src/bootstrap/config/index.js";
import { createAppContext } from "../../../src/bootstrap/factory.js";
import { migrateHomeDir } from "../../../src/bootstrap/migrate.js";
import { runUpdater } from "../../../src/cli/auto-update/run-updater.js";
import { autoUpdateCommand } from "../../../src/cli/commands/auto-update.js";
import { CollectionRegistry, IndexFreshnessCheck } from "../../../src/core/api/index.js";
import type { CollectionEntry } from "../../../src/core/api/public/index.js";

const context = vi.hoisted(() => ({ app: {}, cleanup: vi.fn() }));
vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: vi.fn(() => ({ testConfig: true, codegraphEnabled: process.env.CODEGRAPH_ENABLED })),
}));
vi.mock("../../../src/bootstrap/factory.js", () => ({ createAppContext: vi.fn(async () => context) }));
vi.mock("../../../src/bootstrap/migrate.js", () => ({ migrateHomeDir: vi.fn() }));
vi.mock("../../../src/cli/auto-update/run-updater.js", () => ({ runUpdater: vi.fn() }));

const entry: CollectionEntry = {
  collectionName: "code_x",
  name: "proj",
  path: "/repo/x",
  embeddingModel: "nomic-embed-text",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  codegraphEnabled: true,
  indexedAt: "2026-08-06T00:00:00Z",
  teaRagsVersion: "1.50.0",
  chunksCount: 10,
};
const originalEnv = process.env;
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "auto-update-entrypoint-"));
  process.env = { ...originalEnv, TEA_RAGS_DATA_DIR: dataDir };
  delete process.env.CODEGRAPH_ENABLED;
  vi.spyOn(CollectionRegistry.prototype, "findByName").mockReturnValue(entry);
  vi.spyOn(CollectionRegistry.prototype, "get").mockReturnValue(entry);
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});
const invoke = async (action: string) =>
  (autoUpdateCommand.handler as (args: { action: string; project: string }) => Promise<void>)({
    action,
    project: "proj",
  });

describe("auto-update run entrypoint", () => {
  it("replays identity before building the app, forwards progress and cleans up", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.mocked(runUpdater).mockImplementation(async (collection, deps) => {
      expect(collection).toBe("code_x");
      expect(deps.app).toBe(context.app);
      expect(deps.registry.get(collection)).toEqual(entry);
      expect(deps.clock()).toBeGreaterThan(0);
      deps.out("index updated");
      return 3;
    });
    await invoke("run");
    expect(process.env.CODEGRAPH_ENABLED).toBe("true");
    expect(migrateHomeDir).toHaveBeenCalled();
    expect(parseAppConfig).toHaveBeenCalledTimes(1);
    expect(createAppContext).toHaveBeenCalledWith({ testConfig: true, codegraphEnabled: "true" });
    expect(out).toHaveBeenCalledWith("index updated\n");
    expect(context.cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("cleans up when the updater rejects and preserves the rejection", async () => {
    vi.mocked(runUpdater).mockRejectedValueOnce(new Error("sync failed"));
    await expect(invoke("run")).rejects.toThrow("sync failed");
    expect(context.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports the default data-directory log path for a registered project", async () => {
    vi.spyOn(IndexFreshnessCheck.prototype, "check").mockReturnValue({ kind: "eligible", entry });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await invoke("status");
    expect(out.mock.calls.map(([text]) => String(text)).join("")).toContain(
      join(dataDir, "logs", "auto-update-proj.log"),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
