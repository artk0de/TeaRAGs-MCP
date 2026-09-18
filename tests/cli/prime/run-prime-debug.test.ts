import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { unavailable } from "../../../src/cli/update-check/types.js";

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

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);

function stubUpdateService(): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
}

// The codegraph resolve section renders two ways: plain rates + plain warning
// by default, receiver-kind breakdown under DEBUG. runPrime owns the decision
// and must take it from the parsed config, not from a second env read.
describe("runPrime — debug flag reaches the codegraph resolve section", () => {
  let dataDir: string;
  let projectDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-debug-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "run-prime-debug-proj-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock;

    pingMock.mockResolvedValue(true);
    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "code_x",
          chunksCount: 1,
          codegraphResolve: {
            inProjectEdgeRecall: 0.95,
            resolveSuccessRate: 0.95,
            callsAttempted: 300,
            callsResolved: 285,
            callsExternalSkipped: 0,
            callsUnnarrowedTemplate: 299,
            byLanguage: [
              {
                language: "ruby",
                inProjectEdgeRecall: 0.89,
                resolveSuccessRate: 0.89,
                callsAttempted: 100,
                callsResolved: 89,
                callsExternalSkipped: 0,
                callsUnnarrowedTemplate: 299,
                byReceiverKind: [
                  {
                    receiverKind: "constant",
                    attempted: 100,
                    resolved: 89,
                    externalSkipped: 0,
                    resolveSuccessRate: 0.89,
                    callsUnnarrowedTemplate: 299,
                  },
                ],
              },
            ],
          },
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "code_x",
          totalChunks: 1,
          totalFiles: 1,
          distributions: {},
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: stubUpdateService(),
    });
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("renders the receiver-kind breakdown when the parsed config has debug on", async () => {
    parseAppConfigMock.mockReturnValue({ debug: true });

    await runPrime({ path: projectDir });

    const out = String(writeMock.mock.calls[0][0]);
    expect(out).toContain("  constant 0.89 89/100 · 299 unnarrowed");
    expect(out).not.toContain("resolve rate:");
  });

  it("renders plain rates when the parsed config has debug off", async () => {
    parseAppConfigMock.mockReturnValue({ debug: false });

    await runPrime({ path: projectDir });

    const out = String(writeMock.mock.calls[0][0]);
    expect(out).toContain("resolve rate: ruby 0.89");
    expect(out).not.toContain("89/100");
  });
});
