import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { runPrime, type PrimeRegistryRuntime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";
import { QdrantUnavailableError, TeaRagsError, type CollectionEntry } from "../../../src/core/api/public/index.js";

const { pingMock, buildCheckForUpdateMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  buildCheckForUpdateMock: vi.fn(),
}));

const DIGEST = "# tea-rags digest — proj\nbody\n";

const entry: CollectionEntry = {
  collectionName: "code_proj",
  path: "/some/project",
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-10-23T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
};

function registryRuntime(found: CollectionEntry | null = entry): PrimeRegistryRuntime {
  return {
    openRegistry: () => ({ findByName: () => found, get: () => found }) as never,
    createFreshness: () => ({}) as never,
    externalQdrantUrlOf: () => "http://localhost:6333",
    replayEntryEnv: () => undefined,
  };
}

const resolver = (() => async () => "code_proj") as never;
const noSpawn = { maybeSpawn: () => "disabled" as const };

function fakeSession(
  readResource: InProcessToolSession["readResource"] = async (uri: string) => ({
    contents: [{ uri, mimeType: "text/markdown", text: DIGEST }],
  }),
): InProcessToolSession & { close: ReturnType<typeof vi.fn> } {
  return {
    listTools: vi.fn(),
    callTool: vi.fn(),
    listResources: vi.fn(),
    listResourceTemplates: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    readResource: vi.fn(readResource),
  };
}

function stubUpdateService(): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
}

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  writeMock.mockClear();
  pingMock.mockReset();
  buildCheckForUpdateMock.mockReset();
  process.stdout.write = writeMock;
});
afterEach(() => {
  process.stdout.write = stdoutOriginal;
});

function output(): string {
  return writeMock.mock.calls.map((c) => String(c[0])).join("");
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({
  pingQdrant: pingMock,
}));

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: () => ({}),
}));

vi.mock("../../../src/cli/update-check/check-service.js", () => ({
  UpdateCheckService: class {
    checkForUpdate = buildCheckForUpdateMock;
  },
}));

async function run(extra: Partial<Parameters<typeof runPrime>[0]> & { session?: InProcessToolSession }) {
  const { session, ...rest } = extra;
  return runPrime({
    path: "/some/project",
    createPathCollectionResolver: resolver,
    registryRuntime: registryRuntime(),
    openSession: async () => session ?? fakeSession(),
    updateService: stubUpdateService(),
    autoUpdateTrigger: noSpawn,
    ...rest,
  });
}

describe("runPrime — happy path", () => {
  it("calls session.close in the finally block for best-effort teardown", async () => {
    // The guaranteed process reap lives in the prime command handler
    // (process.exit(0)); close here is best-effort, fire-and-forget by design.
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const session = fakeSession();

    await run({ session });

    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe("runPrime — failure paths", () => {
  it("does NOT open a session when path is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    pingMock.mockClear();
    const openSession = vi.fn();

    await run({ openSession });

    expect(openSession).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("Path not found: /some/project");
  });

  it("does NOT open a session when Qdrant ping fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(false);
    const openSession = vi.fn();

    await run({ openSession });

    expect(openSession).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("readiness and freshness unconfirmed");
    expect(output()).toContain("project `proj` · collection `code_proj`");
  });

  it("retains addressing and cleans up when the digest read rejects after bootstrap", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const session = fakeSession(async () => {
      throw new QdrantUnavailableError("http://localhost:6333", new Error("connection refused"));
    });

    await run({ session });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("readiness and freshness unconfirmed");
    expect(output()).toContain("project `proj` · collection `code_proj`");
    expect(session.close).toHaveBeenCalled();
  });
});

// An unreachable backend does not establish warm-up; other typed failures
// still show their actual error, code and remedy.
describe("runPrime — status failure that is not a cold Qdrant", () => {
  function sessionRejecting(error: unknown) {
    return fakeSession(async () => {
      throw error;
    });
  }

  class LockedCollectionError extends TeaRagsError {
    constructor() {
      super({ code: "INFRA_ALIAS_OPERATION", message: "alias swap in flight", hint: "Retry shortly", httpStatus: 409 });
    }
  }

  it("renders a typed error's message, code and hint instead of 'warm-up pending'", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const session = sessionRejecting(new LockedCollectionError());

    await run({ session });

    const out = output();
    expect(out).not.toContain("warm-up pending");
    expect(out).toContain("alias swap in flight (INFRA_ALIAS_OPERATION)");
    expect(out).toContain("Retry shortly");
    expect(session.close).toHaveBeenCalled();
  });

  // Bootstrap is the other status read that can fail after the ping: a
  // rejection there used to escape runPrime and prime printed nothing at all.
  it("renders a bootstrap failure instead of printing nothing", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);

    await run({
      openSession: async () => {
        throw new LockedCollectionError();
      },
    });

    expect(output()).toContain("alias swap in flight (INFRA_ALIAS_OPERATION)");
  });

  it("keeps known addressing when bootstrap cannot reach Qdrant", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);

    await run({
      openSession: async () => {
        throw new QdrantUnavailableError("http://localhost:6333");
      },
    });

    expect(output()).toContain("readiness and freshness unconfirmed");
    expect(output()).toContain("project `proj` · collection `code_proj`");
  });

  it("renders an untyped error's message instead of 'warm-up pending'", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);

    await run({ session: sessionRejecting(new TypeError("Cannot read properties of undefined (reading 'points')")) });

    const out = output();
    expect(out).not.toContain("warm-up pending");
    expect(out).toContain("Cannot read properties of undefined (reading 'points')");
  });
});

describe("runPrime — cwd fallback", () => {
  it("resolves to process.cwd() when neither path nor project is provided", async () => {
    // Covers hooks whose $CLAUDE_PROJECT_DIR expanded empty: `prime ""` must
    // prime the current working directory instead of erroring "no path provided".
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const resolvePath = vi.fn(async () => "code_proj");

    await run({
      path: undefined,
      registryRuntime: registryRuntime(null),
      createPathCollectionResolver: (() => resolvePath) as never,
    });

    expect(resolvePath).toHaveBeenCalledWith(process.cwd());
  });
});

describe("runPrime — update-check integration", () => {
  it("includes the update section in stdout when available", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const updateService = { checkForUpdate: vi.fn().mockResolvedValue(available("1.0.0", "1.1.0")) };

    await run({ updateService });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("## tea-rags package");
  });

  it("omits the update section when up-to-date", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const updateService = { checkForUpdate: vi.fn().mockResolvedValue(upToDate("1.0.0")) };

    await run({ updateService });

    expect(writeMock.mock.calls[0][0]).not.toContain("## tea-rags package");
  });

  it("does not stall the digest if checkForUpdate rejects (rejections still resolve allSettled)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const updateService = { checkForUpdate: vi.fn().mockRejectedValue(new Error("boom")) };

    await run({ updateService });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags digest");
  });

  it("calls checkForUpdate with allowNetwork=true, timeoutMs=1500, preferCache=true", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const updateService = { checkForUpdate: vi.fn().mockResolvedValue(upToDate("1.0.0")) };

    await run({ updateService });

    expect(updateService.checkForUpdate).toHaveBeenCalledWith({
      allowNetwork: true,
      timeoutMs: 1500,
      preferCache: true,
    });
  });
});

describe("runPrime — buildUpdateService fallback (yl9tv)", () => {
  it("falls through to buildUpdateService when no updateService is injected", async () => {
    // Covers the `?? buildUpdateService()` branch of run-prime.ts; the
    // check-service module is mocked above to avoid real npm network calls.
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    buildCheckForUpdateMock.mockResolvedValue(unavailable("timeout"));

    await run({ updateService: undefined });

    expect(buildCheckForUpdateMock).toHaveBeenCalledOnce();
    expect(writeMock).toHaveBeenCalled();
  });
});
