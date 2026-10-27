/**
 * Faults confined to one connection or one request: a frame the daemon cannot
 * read closes that connection; a response the daemon cannot encode answers that
 * request with an error. The daemon and every other request stay up.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  DAEMON_OP_COMMANDS,
  type DaemonOpCommandTable,
} from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
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

async function startDaemon(opCommands?: DaemonOpCommandTable): Promise<CodegraphDaemonPaths> {
  root = mkdtempSync(join(tmpdir(), "cg-malformed-"));
  const paths = getDaemonPaths(root);
  const { shutdown } = await runDaemon({
    rootDir: root,
    paths,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    exit: () => undefined,
    opCommands,
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

/** Send every request on one connection; resolve with the answers keyed by id. */
async function exchange(sock: Socket, requests: { id: number; op: string }[]): Promise<Map<number, unknown>> {
  const answers = new Map<number, unknown>();
  const done = new Promise<void>((resolve) => {
    let buffered = "";
    sock.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const answer = JSON.parse(buffered.slice(0, newline)) as { id: number };
        answers.set(answer.id, answer);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
      if (answers.size === requests.length) resolve();
    });
  });
  for (const req of requests) sock.write(`${JSON.stringify({ ...req, params: { collection: "" } })}\n`);
  await done;
  return answers;
}

describe("codegraph daemon: a response it cannot encode", () => {
  it("answers that request with an error; the next request on the connection succeeds", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const paths = await startDaemon({
      ping: DAEMON_OP_COMMANDS.ping,
      handshake: { access: "daemon", mutates: false, run: async () => ({ count: 1n }) },
      releaseIdleCollection: { access: "daemon", mutates: false, run: async () => circular },
    });
    const client = await openClient(paths);

    const answers = await exchange(client, [
      { id: 1, op: "handshake" },
      { id: 2, op: "releaseIdleCollection" },
      { id: 3, op: "ping" },
    ]);

    for (const id of [1, 2]) {
      expect(answers.get(id)).toMatchObject({
        id,
        ok: false,
        error: { name: "CodegraphDaemonResponseEncodeError" },
      });
    }
    expect(answers.get(3)).toEqual({ id: 3, ok: true, result: null });
    expect(await ping(await openClient(paths), 4)).toEqual({ id: 4, ok: true, result: null });
  });
});
