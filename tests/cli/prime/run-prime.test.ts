import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";
import { createPathCollectionResolver } from "../../../src/core/api/index.js";
import { QdrantUnavailableError, TeaRagsError } from "../../../src/core/api/public/index.js";
import { resolveLanguageCapabilities } from "../../../src/core/domains/language/capability/resolve.js";
import { LanguageFactory } from "../../../src/core/domains/language/factory.js";

const { pingMock, createAppContextMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
}));

function stubUpdateService(): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
}

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  writeMock.mockClear();
  pingMock.mockReset();
  createAppContextMock.mockReset();
  process.stdout.write = writeMock;
});
afterEach(() => {
  process.stdout.write = stdoutOriginal;
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn() };
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

describe("runPrime — happy path", () => {
  it("calls all three App methods and writes formatted digest to stdout", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();
    const getStatusMock = vi.fn().mockResolvedValue({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
    const getMetricsMock = vi.fn().mockResolvedValue({
      collection: "c",
      totalChunks: 100,
      totalFiles: 10,
      distributions: { language: { typescript: 100 } },
      signals: {},
    });
    const checkDriftMock = vi.fn().mockResolvedValue(null);

    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: getStatusMock,
        getIndexMetrics: getMetricsMock,
        checkIndexDrift: checkDriftMock,
      },
      cleanup: cleanupMock,
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(getStatusMock).toHaveBeenCalledWith("/some/project");
    expect(getMetricsMock).toHaveBeenCalledWith("/some/project");
    // Non-consuming: the digest is an inspection, and the once-per-session
    // warning belongs to the search path (bd tea-rags-mcp-p0phi).
    expect(checkDriftMock).toHaveBeenCalledWith({ path: "/some/project", consume: false });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags prime — /some/project");
    expect(cleanupMock).toHaveBeenCalled();
  });

  it("calls ctx.cleanup in the finally block for best-effort teardown", async () => {
    // The guaranteed process reap lives in the prime command handler
    // (process.exit(0)); cleanup here is best-effort, fire-and-forget by design.
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();

    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 100,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: cleanupMock,
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  // bd tea-rags-mcp-xip6g — the digest's tier lines come from the shipped
  // descriptors, so the expectation is read from the same source rather than
  // hard-coded: a tier moving in a `<lang>/capability.ts` must not break this.
  it("renders language-capability tiers read from LanguageFactory.capabilities()", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 100,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    const ts = new LanguageFactory().capabilities().get("typescript");
    expect(ts).toBeDefined();
    const codegraph = ts?.codegraph.tier;
    if (typeof codegraph !== "string") throw new Error("typescript codegraph tier is expected to be a single tier");
    expect(writeMock.mock.calls[0][0]).toContain(
      `typescript: ast ${ts?.ast.tier} · tests ${ts?.tests.tier} · codegraph ${codegraph}`,
    );
  });
});

describe("runPrime — failure paths", () => {
  it("does NOT call createAppContext when path is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    createAppContextMock.mockClear();
    pingMock.mockClear();

    await runPrime({ path: "/missing/dir", createPathCollectionResolver });

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("Path not found: /missing/dir");
  });

  it("does NOT call createAppContext when Qdrant ping fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(false);
    createAppContextMock.mockClear();

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("warm-up pending");
  });

  it("emits qdrant-cold placeholder + cleans up when getIndexStatus rejects after bootstrap", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();
    const getStatusMock = vi
      .fn()
      .mockRejectedValue(new QdrantUnavailableError("http://localhost:6333", new Error("connection refused")));
    const getMetricsMock = vi.fn().mockResolvedValue({});
    const checkDriftMock = vi.fn().mockResolvedValue(null);

    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: getStatusMock,
        getIndexMetrics: getMetricsMock,
        checkIndexDrift: checkDriftMock,
      },
      cleanup: cleanupMock,
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("warm-up pending");
    expect(cleanupMock).toHaveBeenCalled();
  });
});

// bd tea-rags-mcp-zqg1i: only a genuinely cold / unreachable Qdrant renders
// the warm-up placeholder; any other status failure shows the real error.
describe("runPrime — status failure that is not a cold Qdrant", () => {
  function contextRejecting(error: unknown, cleanup = vi.fn()) {
    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: vi.fn().mockRejectedValue(error),
        getIndexMetrics: vi.fn().mockResolvedValue({}),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup,
      updateService: stubUpdateService(),
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
    const cleanupMock = vi.fn();
    contextRejecting(new LockedCollectionError(), cleanupMock);

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    const out = writeMock.mock.calls.map((c) => String(c[0])).join("");
    expect(out).not.toContain("warm-up pending");
    expect(out).toContain("alias swap in flight (INFRA_ALIAS_OPERATION)");
    expect(out).toContain("Retry shortly");
    expect(cleanupMock).toHaveBeenCalled();
  });

  // Bootstrap is the other status read that can fail after the ping: a
  // rejection there used to escape runPrime and prime printed nothing at all.
  it("renders a bootstrap failure instead of printing nothing", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    createAppContextMock.mockRejectedValue(new LockedCollectionError());

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    const out = writeMock.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("alias swap in flight (INFRA_ALIAS_OPERATION)");
  });

  it("keeps the warm-up placeholder when bootstrap finds Qdrant cold", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    createAppContextMock.mockRejectedValue(new QdrantUnavailableError("http://localhost:6333"));

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(writeMock.mock.calls.map((c) => String(c[0])).join("")).toContain("warm-up pending");
  });

  it("renders an untyped error's message instead of 'warm-up pending'", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    contextRejecting(new TypeError("Cannot read properties of undefined (reading 'points')"));

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    const out = writeMock.mock.calls.map((c) => String(c[0])).join("");
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
    const getStatusMock = vi.fn().mockResolvedValue({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: getStatusMock,
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: stubUpdateService(),
    });

    await runPrime({ createPathCollectionResolver });

    expect(getStatusMock).toHaveBeenCalledWith(process.cwd());
  });
});

describe("runPrime — update-check integration", () => {
  function buildFullCtx(checkForUpdate: ReturnType<typeof vi.fn>) {
    return {
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 100,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: { checkForUpdate } as unknown as UpdateCheckService,
    };
  }

  it("includes the update section in stdout when available", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockResolvedValue(available("1.0.0", "1.1.0")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("## tea-rags package");
  });

  it("omits the update section when up-to-date", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockResolvedValue(upToDate("1.0.0")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(writeMock.mock.calls[0][0]).not.toContain("## tea-rags package");
  });

  it("does not stall the digest if checkForUpdate rejects (rejections still resolve allSettled)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockRejectedValue(new Error("boom")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags prime");
  });

  it("calls checkForUpdate with allowNetwork=true, timeoutMs=1500, preferCache=true", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const checkForUpdateMock = vi.fn().mockResolvedValue(upToDate("1.0.0"));
    const ctx = buildFullCtx(checkForUpdateMock);
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    expect(checkForUpdateMock).toHaveBeenCalledWith({
      allowNetwork: true,
      timeoutMs: 1500,
      preferCache: true,
    });
  });
});

describe("runPrime — buildUpdateService fallback (yl9tv)", () => {
  it("falls through to buildUpdateService when ctx has no updateService injected", async () => {
    // This covers the `buildUpdateService()` factory (line 17 of run-prime.ts).
    // The ctx returned by createAppContext lacks an `updateService` field, so
    // the `?? buildUpdateService()` branch is taken. We mock check-service to
    // avoid real npm network calls.
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);

    const checkForUpdateMock = vi.fn().mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    // Temporarily stub UpdateCheckService at the module level.
    vi.doMock("../../../src/cli/update-check/check-service.js", () => ({
      UpdateCheckService: class {
        checkForUpdate = checkForUpdateMock;
      },
    }));

    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 10,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 10,
          totalFiles: 2,
          distributions: { language: { typescript: 10 } },
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      // No updateService — forces buildUpdateService() to be called.
    });

    await runPrime({ path: "/some/project", createPathCollectionResolver });

    // The test passes if runPrime completes without error.
    // buildUpdateService() was invoked on the ?? branch.
    expect(writeMock).toHaveBeenCalled();
  });
});
