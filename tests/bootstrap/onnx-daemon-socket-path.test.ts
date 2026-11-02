/**
 * The ONNX daemon socket gets the same `sun_path` guard as the codegraph
 * daemon (bd tea-rags-mcp-64j9p): `<appDataDir>/onnx.sock` under a long
 * TEA_RAGS_DATA_DIR used to exceed the bound, and `listen` failed with EINVAL.
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appDataDir, daemonSocketPath } from "../../src/bootstrap/config/paths.js";
import { OnnxDaemon } from "../../src/core/adapters/embeddings/onnx/daemon.js";

const SOCKET_MAX_BYTES = process.platform === "linux" ? 107 : 103;

let savedDataDir: string | undefined;
let root: string;
let daemon: OnnxDaemon | undefined;

beforeEach(() => {
  savedDataDir = process.env.TEA_RAGS_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), "onnx-sock-"));
  const longDataDir = join(root, "d".repeat(90));
  mkdirSync(longDataDir, { recursive: true });
  process.env.TEA_RAGS_DATA_DIR = longDataDir;
});

afterEach(async () => {
  await daemon?.stop().catch(() => undefined);
  daemon = undefined;
  if (savedDataDir === undefined) delete process.env.TEA_RAGS_DATA_DIR;
  else process.env.TEA_RAGS_DATA_DIR = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe("ONNX daemon socket over a long data dir (64j9p)", () => {
  it("daemonSocketPath stays within the platform's unix socket limit", () => {
    expect(Buffer.byteLength(join(appDataDir(), "onnx.sock"))).toBeGreaterThan(SOCKET_MAX_BYTES);
    expect(Buffer.byteLength(daemonSocketPath())).toBeLessThanOrEqual(SOCKET_MAX_BYTES);
  });

  it("the daemon listens on the derived path and a client deriving it again connects", async () => {
    const socketPath = daemonSocketPath();
    daemon = new OnnxDaemon({
      socketPath,
      socketHomeDir: appDataDir(),
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => {
        throw new Error("worker not needed for connect");
      },
    });
    await daemon.start();

    await new Promise<void>((resolve, reject) => {
      const client = createConnection(daemonSocketPath(), () => {
        client.end();
        resolve();
      });
      client.once("error", reject);
    });

    await daemon.stop();
    daemon = undefined;
    expect(() => lstatSync(dirname(socketPath))).toThrow();
  });
});
