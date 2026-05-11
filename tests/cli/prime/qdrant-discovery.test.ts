import { existsSync, readFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverQdrantUrl } from "../../../src/cli/prime/qdrant-discovery.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

const ENV_KEYS = ["QDRANT_URL", "QDRANT_EMBEDDED_STORAGE_PATH", "TEA_RAGS_DATA_DIR"] as const;
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
  vi.mocked(existsSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("discoverQdrantUrl", () => {
  it("uses process.env.QDRANT_URL when set (external override wins over everything)", () => {
    process.env.QDRANT_URL = "http://external-qdrant:6333";
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("63995");

    expect(discoverQdrantUrl({ qdrantUrl: "http://config-url:6333" })).toBe("http://external-qdrant:6333");
  });

  it("uses config.qdrantUrl when QDRANT_URL env is unset", () => {
    expect(discoverQdrantUrl({ qdrantUrl: "http://config-url:6333" })).toBe("http://config-url:6333");
  });

  it("reads daemon.port from default storage path (~/.tea-rags/qdrant) when env+config are absent", () => {
    const expectedPortFile = join(homedir(), ".tea-rags", "qdrant", "daemon.port");
    vi.mocked(existsSync).mockImplementation((p) => p === expectedPortFile);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === expectedPortFile) return "63995";
      throw new Error(`unexpected read ${String(p)}`);
    });

    expect(discoverQdrantUrl({})).toBe("http://127.0.0.1:63995");
  });

  it("respects QDRANT_EMBEDDED_STORAGE_PATH for daemon.port lookup", () => {
    process.env.QDRANT_EMBEDDED_STORAGE_PATH = "/custom/storage";
    const expectedPortFile = "/custom/storage/daemon.port";
    vi.mocked(existsSync).mockImplementation((p) => p === expectedPortFile);
    vi.mocked(readFileSync).mockImplementation((p) => (p === expectedPortFile ? "12345" : ""));

    expect(discoverQdrantUrl({})).toBe("http://127.0.0.1:12345");
  });

  it("uses TEA_RAGS_DATA_DIR + '/qdrant' when QDRANT_EMBEDDED_STORAGE_PATH not set", () => {
    process.env.TEA_RAGS_DATA_DIR = "/var/tea";
    const expectedPortFile = "/var/tea/qdrant/daemon.port";
    vi.mocked(existsSync).mockImplementation((p) => p === expectedPortFile);
    vi.mocked(readFileSync).mockImplementation((p) => (p === expectedPortFile ? "7000" : ""));

    expect(discoverQdrantUrl({})).toBe("http://127.0.0.1:7000");
  });

  it("falls back to http://localhost:6333 when daemon.port does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(discoverQdrantUrl({})).toBe("http://localhost:6333");
  });

  it("falls back to localhost:6333 when daemon.port is unreadable or contains garbage", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-a-port");

    expect(discoverQdrantUrl({})).toBe("http://localhost:6333");
  });

  it("trims whitespace from daemon.port content", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("  63995\n");

    expect(discoverQdrantUrl({})).toBe("http://127.0.0.1:63995");
  });
});
