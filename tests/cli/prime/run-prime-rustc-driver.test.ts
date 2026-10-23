import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRegistryEnvCodeDefaults } from "../../../src/bootstrap/config/registry-env-code-defaults.js";
import { primeRegistryRuntime } from "../../../src/cli/prime/registry-runtime.js";
import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { unavailable } from "../../../src/cli/update-check/types.js";
import { createPathCollectionResolver } from "../../../src/core/api/index.js";
import type { RustcDriverStatus } from "../../../src/core/api/public/index.js";
import { resolveLanguageCapabilities } from "../../../src/core/domains/language/capability/resolve.js";

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
  resolveRegistryEnvCodeDefaults,
}));

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);

// bd s3i8m — prime reports how the rustc driver settled on the last Rust
// resolve pass, read from the status the codegraph DB persisted with that run.
describe("runPrime — rustc driver line from the persisted status", () => {
  let dataDir: string;
  let projectDir: string;

  function wireStatus(rustcDriver: RustcDriverStatus | undefined): void {
    createAppContextMock.mockResolvedValue({
      app: {
        resolveLanguageCapabilities,
        resolveRustAnalyzerInstallHint: () => null,
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "code_x",
          chunksCount: 1,
          ...(rustcDriver ? { rustcDriver } : {}),
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "code_x",
          totalChunks: 1,
          totalFiles: 1,
          distributions: { language: { rust: 1 } },
          signals: {},
        }),
        checkIndexDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: {
        checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")),
      } as unknown as UpdateCheckService,
    });
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-rustc-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "run-prime-rustc-proj-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock;
    pingMock.mockResolvedValue(true);
    parseAppConfigMock.mockReturnValue({ debug: false });
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("renders the driver line the status carries", async () => {
    wireStatus({ outcome: "indexed", cacheHit: true, units: 9 });

    await runPrime({ registryRuntime: primeRegistryRuntime(), path: projectDir, createPathCollectionResolver });

    expect(String(writeMock.mock.calls[0][0])).toContain(
      "rustc driver: indexed (cache hit, cargo check not re-run) · units 9",
    );
  });

  it("renders no driver line when no Rust resolve pass recorded one", async () => {
    wireStatus(undefined);

    await runPrime({ registryRuntime: primeRegistryRuntime(), path: projectDir, createPathCollectionResolver });

    expect(String(writeMock.mock.calls[0][0])).not.toContain("rustc driver:");
  });
});
