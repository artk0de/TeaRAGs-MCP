import { afterEach, describe, expect, it, vi } from "vitest";

const createAppContext = vi.fn();
const parseAppConfig = vi.fn(() => ({ parsed: true }));

vi.mock("../../../src/bootstrap/config/index.js", () => ({ parseAppConfig }));
vi.mock("../../../src/bootstrap/factory.js", () => ({ createAppContext }));

const { resolveCodegraphResidualCommand, runResolveCodegraphResidual } =
  await import("../../../src/cli/commands/resolve-codegraph-residual.js");
const { skippedResidualReport } = await import("../../../src/core/api/internal/ops/residual-resolve-port.js");

afterEach(() => {
  vi.restoreAllMocks();
  createAppContext.mockReset();
});

describe("resolve-codegraph-residual calibration wiring", () => {
  it("fails loudly when the context cannot calibrate", async () => {
    await expect(
      runResolveCodegraphResidual(
        { path: "/repo", model: "kev", calibrate: true },
        { createContext: async () => ({ resolveCodegraphResidual: vi.fn() }), write: vi.fn() },
      ),
    ).rejects.toThrow("residual calibration is not available");
  });

  it("streams progress to stderr for a human run and closes the line, but stays silent in JSON mode", async () => {
    const report = {
      outcome: "completed" as const,
      sampleRows: 0,
      cacheHits: 0,
      asked: 0,
      answered: 0,
      failedRequests: 0,
      strata: { fullMenu: 0, block1: 0, external: 0 },
      records: [],
    };
    const calibrate = vi.fn(
      async (_path: string, _model: string, options: { onProgress?: (p: { message: string }) => void }) => {
        options.onProgress?.({ message: "asking 3/9" });
        return report;
      },
    );
    const progress = vi.fn();
    const human = await runResolveCodegraphResidual(
      { path: "/repo", model: "kev", calibrate: true },
      {
        createContext: async () => ({ resolveCodegraphResidual: vi.fn(), calibrateCodegraphResidual: calibrate }),
        write: vi.fn(),
        progress,
      },
    );
    expect(human).toBe(0);
    expect(progress.mock.calls.map((c) => c[0])).toEqual(["\rasking 3/9", "\n"]);

    const jsonProgress = vi.fn();
    await runResolveCodegraphResidual(
      { path: "/repo", model: "kev", calibrate: true, json: true },
      {
        createContext: async () => ({ resolveCodegraphResidual: vi.fn(), calibrateCodegraphResidual: calibrate }),
        write: vi.fn(),
        progress: jsonProgress,
      },
    );
    expect(jsonProgress).not.toHaveBeenCalled();
  });

  it("runs the cleanup hook after a pass even when it throws", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(
      runResolveCodegraphResidual(
        { path: "/repo", model: "kev" },
        {
          createContext: async () => ({
            resolveCodegraphResidual: vi.fn().mockRejectedValue(new Error("model down")),
            cleanup,
          }),
          write: vi.fn(),
        },
      ),
    ).rejects.toThrow("model down");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("resolve-codegraph-residual command handler", () => {
  it("builds the app context from parsed config, runs the pass for the path and exits with its code", async () => {
    const resolveCodegraphResidual = vi.fn().mockResolvedValue({
      ...skippedResidualReport("no index", "cacheOnly"),
    });
    createAppContext.mockResolvedValue({ resolveCodegraphResidual });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await resolveCodegraphResidualCommand.handler({
      $0: "tea-rags",
      _: [],
      model: "kev",
      "cache-only": true,
      calibrate: false,
      json: true,
      path: "/tmp/residual-wiring-repo",
    });

    expect(parseAppConfig).toHaveBeenCalled();
    expect(createAppContext).toHaveBeenCalledWith({ parsed: true });
    expect(resolveCodegraphResidual).toHaveBeenCalledWith(
      "/tmp/residual-wiring-repo",
      "kev",
      expect.objectContaining({ mode: "cacheOnly" }),
    );
    expect(JSON.parse(String(stdout.mock.calls[0][0])).outcome).toBe("skipped");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
