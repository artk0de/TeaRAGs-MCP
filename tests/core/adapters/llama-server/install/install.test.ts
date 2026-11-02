import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LlamaServerBinaryMissingError } from "../../../../../src/core/adapters/llama-server/install/errors.js";
import { downloadLlamaServer } from "../../../../../src/core/adapters/llama-server/install/install.js";

const execFileAsync = promisify(execFile);
const run = async (cmd: string, args: string[]): Promise<void> => {
  await execFileAsync(cmd, args);
};

/** Fixture archives, built once: asset name → bytes; their digests replace the pinned manifest. */
const fixtures = vi.hoisted(() => ({ archives: new Map<string, Buffer>() }));

vi.mock("../../../../../src/core/adapters/llama-server/install/llama-cpp-manifest.generated.js", async () => {
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cpp-fixture-"));
  const pack = (asset: string, files: Record<string, string>): void => {
    const content = path.join(root, `${asset}.content`);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(content, rel)), { recursive: true });
      fs.writeFileSync(path.join(content, rel), body);
    }
    const archive = path.join(root, asset);
    execFileSync("tar", ["-czf", archive, "-C", content, "llama-b12032"]);
    fixtures.archives.set(asset, fs.readFileSync(archive));
  };
  pack("llama-b12032-bin-macos-arm64.tar.gz", { "llama-b12032/llama-server": "server bytes" });
  pack("llama-b12032-bin-ubuntu-cuda-13.4-x64.tar.gz", { "llama-b12032/llama-server": "cuda server bytes" });
  pack("cudart-llama-b12032-bin-ubuntu-cuda-13.4-x64.tar.gz", { "llama-b12032/libcudart.so.13": "cudart bytes" });
  fs.rmSync(root, { recursive: true, force: true });

  const sha = Object.fromEntries(
    [...fixtures.archives].map(([asset, bytes]) => [asset, createHash("sha256").update(bytes).digest("hex")]),
  );
  return { LLAMA_CPP_BUILD: "b12032", LLAMA_CPP_ASSET_SHA256: sha };
});

const RELEASE_BASE = "https://github.com/ggml-org/llama.cpp/releases/download/b12032/";

describe("downloadLlamaServer", () => {
  let dataDir: string;
  let requested: string[];
  const fetch = async (input: string): Promise<Response> => {
    requested.push(input);
    const bytes = fixtures.archives.get(input.slice(RELEASE_BASE.length));
    return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(bytes));
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "llama-install-"));
    requested = [];
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("downloads the pinned release asset, publishes it under <dataDir>/llama.cpp/<build>-<backend> and returns llama-server", async () => {
    const path = await downloadLlamaServer(
      { dataDir, platform: "darwin", arch: "arm64", backend: "metal" },
      { fetch, run },
    );

    expect(path).toBe(join(dataDir, "llama.cpp", "b12032-metal", "llama-b12032", "llama-server"));
    expect(readFileSync(path, "utf-8")).toBe("server bytes");
    expect(requested).toEqual([`${RELEASE_BASE}llama-b12032-bin-macos-arm64.tar.gz`]);
    expect(existsSync(join(dataDir, "llama.cpp", "b12032-metal.staging"))).toBe(false);
  });

  it("extracts the cudart companion into the same install dir", async () => {
    const path = await downloadLlamaServer(
      { dataDir, platform: "linux", arch: "x64", backend: "cuda" },
      { fetch, run },
    );

    const installDir = join(dataDir, "llama.cpp", "b12032-cuda", "llama-b12032");
    expect(path).toBe(join(installDir, "llama-server"));
    expect(readFileSync(join(installDir, "libcudart.so.13"), "utf-8")).toBe("cudart bytes");
    expect(requested).toHaveLength(2);
  });

  it("a second call on an installed backend makes no request", async () => {
    const first = await downloadLlamaServer(
      { dataDir, platform: "darwin", arch: "arm64", backend: "metal" },
      { fetch, run },
    );
    requested = [];

    const second = await downloadLlamaServer(
      { dataDir, platform: "darwin", arch: "arm64", backend: "metal" },
      { fetch, run },
    );

    expect(second).toBe(first);
    expect(requested).toEqual([]);
  });

  it("an archive without llama-server publishes nothing", async () => {
    const emptyRun = async (cmd: string, args: string[]): Promise<void> => {
      // Extract, then drop the binary: the staged tree has no llama-server.
      await run(cmd, args);
      rmSync(join(args[args.indexOf("-C") + 1], "llama-b12032", "llama-server"), { force: true });
    };

    await expect(
      downloadLlamaServer({ dataDir, platform: "darwin", arch: "arm64", backend: "metal" }, { fetch, run: emptyRun }),
    ).rejects.toThrow(/llama-server/);
    expect(existsSync(join(dataDir, "llama.cpp", "b12032-metal"))).toBe(false);
  });

  it("an archive without llama-server fails as a typed error carrying a hint", async () => {
    const emptyRun = async (cmd: string, args: string[]): Promise<void> => {
      await run(cmd, args);
      rmSync(join(args[args.indexOf("-C") + 1], "llama-b12032", "llama-server"), { force: true });
    };

    const failure = await downloadLlamaServer(
      { dataDir, platform: "darwin", arch: "arm64", backend: "metal" },
      { fetch, run: emptyRun },
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(LlamaServerBinaryMissingError);
    expect((failure as LlamaServerBinaryMissingError).code).toBe("INFRA_LLAMA_SERVER_BINARY_MISSING");
    expect((failure as LlamaServerBinaryMissingError).hint).not.toBe("");
  });
});
