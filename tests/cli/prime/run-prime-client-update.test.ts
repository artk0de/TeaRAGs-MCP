import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { runPrime, type PrimeRegistryRuntime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { upToDate } from "../../../src/cli/update-check/types.js";
import type { CollectionEntry } from "../../../src/core/api/public/index.js";

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn() }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});
vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({ pingQdrant: pingMock }));
vi.mock("../../../src/bootstrap/config/index.js", () => ({ parseAppConfig: () => ({}) }));

const DIGEST = "# tea-rags digest — proj\nbody\n";
const REFRESH = '→ run `tea-rags prime "$CLAUDE_PROJECT_DIR"` to refresh this digest after re-indexing';
const HINT = "run `tea-rags update` by hand to re-pin the Claude Code plugins";

const entry: CollectionEntry = {
  collectionName: "code_proj",
  path: "/repo/proj",
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-10-23T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
};

function registryRuntime(found: CollectionEntry | null): PrimeRegistryRuntime {
  return {
    openRegistry: () => ({ findByName: () => found, get: () => found }) as never,
    createFreshness: () => ({}) as never,
    externalQdrantUrlOf: () => "http://localhost:6333",
    replayEntryEnv: () => undefined,
  };
}

function fakeSession(): InProcessToolSession {
  return {
    listTools: vi.fn(),
    callTool: vi.fn(),
    listResources: vi.fn(),
    listResourceTemplates: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    readResource: vi.fn(async (uri: string) => ({ contents: [{ uri, mimeType: "text/markdown", text: DIGEST }] })),
  };
}

const updateService = {
  checkForUpdate: vi.fn().mockResolvedValue(upToDate("1.0.0")),
} as unknown as UpdateCheckService;

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  writeMock.mockClear();
  pingMock.mockReset();
  vi.mocked(existsSync).mockReturnValue(true);
  process.stdout.write = writeMock;
});
afterEach(() => {
  process.stdout.write = stdoutOriginal;
});

function output(): string {
  return writeMock.mock.calls.map((call) => String(call[0])).join("");
}

const resolver = (() => async () => "code_proj") as never;

describe("runPrime — client auto-update", () => {
  it("fires the client-update trigger and prints the manual-update hint before the refresh line", async () => {
    pingMock.mockResolvedValue(true);
    const clientUpdateTrigger = { maybeSpawn: vi.fn(() => "spawned" as const), manualUpdateHint: () => HINT };

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession: async () => fakeSession(),
      updateService,
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
      clientUpdateTrigger,
    });

    expect(clientUpdateTrigger.maybeSpawn).toHaveBeenCalledTimes(1);
    const lines = output().trimEnd().split("\n");
    expect(lines.at(-1)).toBe(REFRESH);
    expect(output()).toContain(`tea-rags client: ${HINT}`);
  });

  it("carries the hint into the --agent digest too", async () => {
    pingMock.mockResolvedValue(true);
    await runPrime({
      path: "/repo/proj",
      agent: true,
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession: async () => fakeSession(),
      updateService,
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
      clientUpdateTrigger: { maybeSpawn: () => "throttled", manualUpdateHint: () => HINT },
    });
    expect(output()).toContain(`tea-rags client: ${HINT}`);
  });

  it("fires the trigger even when prime exits early on a cold Qdrant", async () => {
    pingMock.mockResolvedValue(false);
    const clientUpdateTrigger = { maybeSpawn: vi.fn(() => "spawned" as const), manualUpdateHint: () => null };

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession: async () => fakeSession(),
      updateService,
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
      clientUpdateTrigger,
    });

    expect(clientUpdateTrigger.maybeSpawn).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain("tea-rags client:");
  });
});
