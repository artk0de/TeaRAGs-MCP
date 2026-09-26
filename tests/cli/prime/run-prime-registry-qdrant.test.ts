import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { CollectionEntry } from "../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/collection-registry.js";

const { pingMock, createAppContextMock, parseAppConfigMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
  parseAppConfigMock: vi.fn(),
}));

vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({
  pingQdrant: pingMock,
}));

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: createAppContextMock,
}));

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: parseAppConfigMock,
  getZodConfig: () => ({ deprecations: [] }),
}));

const LIVE_DAEMON_PORT = 52545;
const LIVE_DAEMON_URL = `http://127.0.0.1:${LIVE_DAEMON_PORT}`;

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);

/**
 * Which Qdrant prime pings for a registered project (bd tea-rags-mcp-lzynm).
 *
 * The registry entry's backend is decided by ONE resolver,
 * `resolveRegistryQdrantBackend`. An entry written before the `embedded`
 * sentinel existed stores the daemon's frozen ephemeral port and no
 * `qdrantEmbedded` flag; the daemon rebinds a new port on every restart, so
 * pinging that frozen address reports a live daemon as cold — and prime then
 * bails before the auto-update trigger that would rewrite the entry.
 */
describe("runPrime — registry qdrant backend resolution", () => {
  let dataDir: string;
  let projectDir: string;
  const savedQdrantUrl = process.env.QDRANT_URL;
  const savedStoragePath = process.env.QDRANT_EMBEDDED_STORAGE_PATH;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-qdrant-"));
    projectDir = mkdtempSync(join(tmpdir(), "rp-qdrant-proj-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_EMBEDDED_STORAGE_PATH;
    mkdirSync(join(dataDir, "qdrant"), { recursive: true });
    writeFileSync(join(dataDir, "qdrant", "daemon.port"), String(LIVE_DAEMON_PORT));
    writeMock.mockClear();
    pingMock.mockReset();
    // Cold on purpose: the assertion is WHICH address prime probed, and a
    // cold answer ends runPrime before any bootstrap has to be stubbed.
    pingMock.mockResolvedValue(false);
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    parseAppConfigMock.mockReturnValue({ embedding: {} });
    process.stdout.write = writeMock;
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    if (savedQdrantUrl === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = savedQdrantUrl;
    if (savedStoragePath === undefined) delete process.env.QDRANT_EMBEDDED_STORAGE_PATH;
    else process.env.QDRANT_EMBEDDED_STORAGE_PATH = savedStoragePath;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function register(
    fields: Pick<CollectionEntry, "qdrantUrl" | "teaRagsVersion"> & { qdrantEmbedded?: boolean },
  ): void {
    const registry = new CollectionRegistry(dataDir);
    registry.record({
      collectionName: "code_marketplace",
      path: projectDir,
      embeddingModel: "jina",
      embeddingDimensions: 768,
      indexedAt: "2026-05-26T19:08:57.669Z",
      chunksCount: 306,
      ...fields,
    });
    registry.setName("code_marketplace", "marketplace");
  }

  it("re-resolves the live daemon for a pre-sentinel entry pinning a frozen ephemeral port", async () => {
    register({ qdrantUrl: "http://127.0.0.1:58372", teaRagsVersion: "1.28.0" });

    await runPrime({ project: "marketplace" });

    expect(pingMock).toHaveBeenCalledTimes(1);
    expect(pingMock).toHaveBeenCalledWith(LIVE_DAEMON_URL);
  });

  it("re-resolves the live daemon for the embedded sentinel", async () => {
    register({ qdrantUrl: "embedded", qdrantEmbedded: true, teaRagsVersion: "1.44.2" });

    await runPrime({ project: "marketplace" });

    expect(pingMock).toHaveBeenCalledWith(LIVE_DAEMON_URL);
  });

  it("pings the recorded address of an external Qdrant", async () => {
    register({ qdrantUrl: "http://qdrant.internal:6333", teaRagsVersion: "1.28.0" });

    await runPrime({ project: "marketplace" });

    expect(pingMock).toHaveBeenCalledWith("http://qdrant.internal:6333");
  });

  it("falls back to discovery when the entry's backend cannot be resolved", async () => {
    // 1.33.0-era contradiction: flag says embedded, address says external.
    register({ qdrantUrl: "http://qdrant.internal:6333", qdrantEmbedded: true, teaRagsVersion: "1.33.0" });

    await runPrime({ project: "marketplace" });

    expect(pingMock).toHaveBeenCalledWith(LIVE_DAEMON_URL);
    expect(writeMock.mock.calls.map((c) => String(c[0])).join("")).toContain("warm-up pending");
  });
});
