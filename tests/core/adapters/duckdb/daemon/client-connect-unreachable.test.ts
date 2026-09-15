/**
 * A daemon that never starts listening surfaces as a typed error
 * (bd tea-rags-mcp-a43tr). Optional codegraph consumers degrade on the
 * codegraph-unavailable family by class; a bare `Error` here made "daemon
 * unreachable" indistinguishable from a programming error.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DaemonGraphDbClient } from "../../../../../src/core/adapters/duckdb/daemon/client.js";
import { CodegraphDaemonUnreachableError } from "../../../../../src/core/adapters/duckdb/errors.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("DaemonGraphDbClient#init — daemon not listening", () => {
  it("rejects with CodegraphDaemonUnreachableError once the connect window closes", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-unreachable-"));
    const socketPath = join(root, "absent.sock");
    const client = new DaemonGraphDbClient(socketPath, "code_x", { connectTimeoutMs: 60, retryDelayMs: 10 });

    const err = await client.init().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CodegraphDaemonUnreachableError);
    expect((err as Error).message).toMatch(/failed to connect/);
    expect((err as Error).message).toContain(socketPath);
  });
});
