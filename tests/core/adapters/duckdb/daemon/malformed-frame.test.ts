/**
 * A frame the daemon cannot read is one client's protocol error, not the
 * daemon's: that connection is closed, the daemon and every other connection
 * stay up.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../../../../src/core/domains/maintenance/migration/database/index.js";

let root: string | undefined;
const sockets: Socket[] = [];
const shutdowns: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const sock of sockets.splice(0)) sock.destroy();
  for (const shutdown of shutdowns.splice(0)) await shutdown().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function startDaemon(): Promise<CodegraphDaemonPaths> {
  root = mkdtempSync(join(tmpdir(), "cg-malformed-"));
  const paths = getDaemonPaths(root);
  const { shutdown } = await runDaemon({
    rootDir: root,
    paths,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    exit: () => undefined,
  });
  shutdowns.push(shutdown);
  return paths;
}

async function openClient(paths: CodegraphDaemonPaths): Promise<Socket> {
  const sock = connect(paths.socketPath);
  sockets.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  return sock;
}

async function closed(sock: Socket): Promise<void> {
  return new Promise((resolve) => {
    sock.once("close", () => {
      resolve();
    });
  });
}

async function ping(sock: Socket, id: number): Promise<unknown> {
  const answer = new Promise<unknown>((resolve) => {
    let buffered = "";
    sock.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(buffered.slice(0, newline)));
    });
  });
  sock.write(`${JSON.stringify({ id, op: "ping", params: { collection: "" } })}\n`);
  return answer;
}

describe("codegraph daemon: a malformed frame", () => {
  for (const [label, frame] of [
    ["is not JSON", "{not json"],
    ["is JSON but not a request", "null"],
    ["carries no numeric id", JSON.stringify({ op: "ping", params: {} })],
  ] as const) {
    it(`that ${label} closes only its own connection; another client keeps working`, async () => {
      const paths = await startDaemon();
      const offender = await openClient(paths);
      const bystander = await openClient(paths);

      const offenderClosed = closed(offender);
      offender.write(`${frame}\n`);
      await offenderClosed;

      expect(await ping(bystander, 7)).toEqual({ id: 7, ok: true, result: null });
    });
  }
});
