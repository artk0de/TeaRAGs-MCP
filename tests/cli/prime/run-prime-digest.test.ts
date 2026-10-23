import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { runPrime, type PrimeRegistryRuntime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, upToDate } from "../../../src/cli/update-check/types.js";
import type { CollectionEntry } from "../../../src/core/api/public/index.js";

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn() }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});
vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({ pingQdrant: pingMock }));
vi.mock("../../../src/bootstrap/config/index.js", () => ({ parseAppConfig: () => ({}) }));

const DIGEST = `# tea-rags digest — proj\n${"x".repeat(1_960)}\n→ thresholds / labelMap: tea-rags://project/proj/metrics?language=<lang>\n`;
const METRICS = "## Signal thresholds — typescript\n| signal | low |\n";
const REFRESH = '→ run `tea-rags prime "$CLAUDE_PROJECT_DIR"` to refresh this digest after re-indexing';

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

function fakeSession(): InProcessToolSession & { readResource: ReturnType<typeof vi.fn> } {
  return {
    listTools: vi.fn(),
    callTool: vi.fn(),
    listResources: vi.fn(),
    listResourceTemplates: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    readResource: vi.fn(async (uri: string) => ({
      contents: [{ uri, mimeType: "text/markdown", text: uri.endsWith("/digest") ? DIGEST : METRICS }],
    })),
  };
}

function updateService(status = upToDate("1.0.0")): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(status) } as unknown as UpdateCheckService;
}

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

describe("runPrime — reads the project digest resource", () => {
  it("prints the digest resource, then the update notice and the refresh line", async () => {
    pingMock.mockResolvedValue(true);
    const session = fakeSession();

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession: async () => session,
      updateService: updateService(available("1.0.0", "1.1.0")),
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
    });

    expect(session.readResource).toHaveBeenCalledWith("tea-rags://project/proj/digest");
    expect(session.readResource).toHaveBeenCalledTimes(1);
    const out = output();
    expect(out.startsWith(DIGEST)).toBe(true);
    expect(out).toContain("## tea-rags package");
    expect(out.trimEnd().endsWith(REFRESH)).toBe(true);
    expect(out).not.toContain("Signal thresholds");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2_700);
  });

  it("appends the metrics resource after the digest with --full", async () => {
    pingMock.mockResolvedValue(true);
    const session = fakeSession();

    await runPrime({
      path: "/repo/proj",
      full: true,
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession: async () => session,
      updateService: updateService(),
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
    });

    expect(session.readResource).toHaveBeenCalledWith("tea-rags://project/proj/metrics");
    const out = output();
    expect(out.indexOf(METRICS.trimEnd())).toBeGreaterThan(out.indexOf("tea-rags://project/proj/metrics?language"));
  });

  it("prints the qdrant-cold placeholder and opens no session when Qdrant is unreachable", async () => {
    pingMock.mockResolvedValue(false);
    const openSession = vi.fn();

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession,
      updateService: updateService(),
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(output()).toBe(
      "# tea-rags prime — /repo/proj\n" +
        "Qdrant warm-up pending — index queries will be available after MCP server attaches.\n",
    );
  });

  it("prints the not-indexed placeholder and opens no session for an unregistered path", async () => {
    pingMock.mockResolvedValue(true);
    const openSession = vi.fn();

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(null),
      openSession,
      updateService: updateService(),
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(output()).toBe(
      "# tea-rags prime — /repo/proj\nnot indexed. Run `/tea-rags:index` to index this codebase.\n",
    );
  });

  it("renders the session failure with its message instead of printing nothing", async () => {
    pingMock.mockResolvedValue(true);

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(entry),
      openSession: async () => {
        throw new Error("bootstrap exploded");
      },
      updateService: updateService(),
    });

    expect(output()).toBe("# tea-rags prime — /repo/proj\nIndex status unavailable: bootstrap exploded\n");
  });

  it("addresses a nameless registry entry by its collection name", async () => {
    pingMock.mockResolvedValue(true);
    const session = fakeSession();
    const { name: _name, ...nameless } = entry;

    await runPrime({
      path: "/repo/proj",
      createPathCollectionResolver: resolver,
      registryRuntime: registryRuntime(nameless as CollectionEntry),
      openSession: async () => session,
      updateService: updateService(),
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
    });

    expect(session.readResource).toHaveBeenCalledWith("tea-rags://project/code_proj/digest");
  });
});
