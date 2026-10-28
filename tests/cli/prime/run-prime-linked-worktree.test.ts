import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { runPrime, type PrimeRegistryRuntime } from "../../../src/cli/prime/run-prime.js";
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

const REPO = "/repo/proj";
const WORKTREE = `${REPO}/.claude/worktrees/feature`;

const repoEntry: CollectionEntry = {
  collectionName: "code_proj",
  path: REPO,
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-10-23T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
};

/** A registry where the linked worktree's path hash names a collection nobody indexed. */
function registryRuntime(): PrimeRegistryRuntime {
  return {
    openRegistry: () => ({ findByName: () => null, get: () => null }) as never,
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
      contents: [{ uri, mimeType: "text/markdown", text: DIGEST }],
    })),
  };
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

const unregisteredHashResolver = (() => async () => "code_worktree_hash") as never;

describe("runPrime — linked worktree of a registered repository", () => {
  it("reads the repository's digest when the injected base-index resolver maps the worktree to it", async () => {
    pingMock.mockResolvedValue(true);
    const session = fakeSession();
    const resolveBaseIndexEntry = vi.fn(() => repoEntry) as never;

    await runPrime({
      path: WORKTREE,
      agent: true,
      createPathCollectionResolver: unregisteredHashResolver,
      resolveBaseIndexEntry,
      registryRuntime: registryRuntime(),
      openSession: async () => session,
      updateService: { checkForUpdate: vi.fn().mockResolvedValue(upToDate("1.0.0")) },
      autoUpdateTrigger: { maybeSpawn: () => "disabled" },
    });

    expect(session.readResource).toHaveBeenCalledWith("tea-rags://project/proj/digest");
    expect(output()).toContain(DIGEST.trimEnd());
    expect(output()).not.toContain("not indexed");
  });

  it("still prints the not-indexed placeholder when no base-index resolver is injected", async () => {
    pingMock.mockResolvedValue(true);
    const openSession = vi.fn();

    await runPrime({
      path: WORKTREE,
      createPathCollectionResolver: unregisteredHashResolver,
      registryRuntime: registryRuntime(),
      openSession,
    });

    expect(output()).toContain("not indexed");
    expect(openSession).not.toHaveBeenCalled();
  });
});
