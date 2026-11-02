import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LlamaServerPoolStartError } from "../../../../../src/core/adapters/llama-server/pools/errors.js";
import { isLoopbackPortFree } from "../../../../../src/core/adapters/llama-server/pools/ports.js";
import { productionLlamaServerPoolsDeps } from "../../../../../src/core/adapters/llama-server/pools/production-deps.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("isLoopbackPortFree", () => {
  it("reports a bound port busy and the same port free once released", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as { port: number };
    expect(await isLoopbackPortFree(port)).toBe(false);
    await new Promise<void>((resolve) =>
      holder.close(() => {
        resolve();
      }),
    );
    expect(await isLoopbackPortFree(port)).toBe(true);
  });
});

describe("productionLlamaServerPoolsDeps", () => {
  it("wires real process, binary-resolution and timing seams", async () => {
    dir = mkdtempSync(join(tmpdir(), "pools-deps-"));
    const deps = productionLlamaServerPoolsDeps({
      dataDir: dir,
      env: { LLAMA_SERVER_PATH: "/opt/llama-server" },
      which: () => null,
    });

    expect(deps.resolveBinary()).toBe("/opt/llama-server");
    expect(deps.isAlive(process.pid)).toBe(true);
    expect(deps.random()).toBeGreaterThanOrEqual(0);
    expect(deps.now()).toBeGreaterThan(0);
    await deps.sleep(1);
    expect(() => {
      deps.kill(2 ** 22 + 999);
    }).not.toThrow();
  });

  it("falls back to PATH when no env override and no managed install exists", () => {
    dir = mkdtempSync(join(tmpdir(), "pools-deps-"));
    const deps = productionLlamaServerPoolsDeps({ dataDir: dir, env: {}, which: () => "/usr/bin/llama-server" });
    expect(deps.resolveBinary()).toBe("/usr/bin/llama-server");
  });

  it("spawns a detached process logging to the given file, and rejects an unstartable binary", () => {
    dir = mkdtempSync(join(tmpdir(), "pools-deps-"));
    const deps = productionLlamaServerPoolsDeps({ dataDir: dir, env: {}, which: () => null });
    const logPath = join(dir, "logs", "a.log");

    const { pid } = deps.spawn(process.execPath, ["-e", "console.log('hello-pool')"], logPath);
    expect(pid).toBeGreaterThan(0);
    expect(readFileSync(logPath, "utf8")).toBeDefined();

    expect(() => deps.spawn(join(dir, "missing-binary"), [], join(dir, "logs", "b.log"))).toThrow(
      LlamaServerPoolStartError,
    );
  });
});
