/**
 * The shared `sun_path` guard for every unix-socket daemon (bd
 * tea-rags-mcp-8tbaa, tea-rags-mcp-64j9p): an over-long socket path moves under
 * a short PER-USER alias dir, and an alias some other user planted there is
 * refused with a typed error instead of a raw fs failure at `listen`.
 */
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UnixSocketDirForeignOwnerError } from "../../../../src/core/adapters/filesystem/errors.js";
import {
  boundedUnixSocketPath,
  ensureUnixSocketDir,
  removeUnixSocketAlias,
} from "../../../../src/core/adapters/filesystem/unix-socket-path.js";

const LONG_HOME = `/Users/${"u".repeat(40)}/Library/Application Support/${"x".repeat(40)}`;

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real home dir whose `onnx.sock` path exceeds every platform's bound. */
function makeLongHome(): string {
  const root = mkdtempSync(join(tmpdir(), "usp-"));
  cleanups.push(root);
  const home = join(root, "h".repeat(90));
  mkdirSync(home, { recursive: true });
  return home;
}

function ownUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("posix-only test");
  return uid;
}

describe("boundedUnixSocketPath (8tbaa, 64j9p)", () => {
  it("names the alias dir per user, so another user's alias never collides", () => {
    const host = { platform: "darwin" as const, tmpDir: "/var/folders/ab/cd/T" };
    const mine = boundedUnixSocketPath(LONG_HOME, "onnx.sock", { ...host, uid: 501 });
    const theirs = boundedUnixSocketPath(LONG_HOME, "onnx.sock", { ...host, uid: 502 });
    expect(basename(dirname(mine))).toMatch(/^tea-rags-501-[0-9a-f]{12}$/);
    expect(theirs).not.toBe(mine);
  });

  it("puts the uid in the /tmp fallback name too", () => {
    const socket = boundedUnixSocketPath(LONG_HOME, "onnx.sock", {
      platform: "darwin",
      tmpDir: `/var/${"t".repeat(90)}`,
      uid: 501,
    });
    expect(socket.startsWith("/tmp/tea-rags-501-")).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  });

  it("is deterministic for the same home dir and user", () => {
    const host = { platform: "linux" as const, tmpDir: "/tmp", uid: 1000 };
    expect(boundedUnixSocketPath(LONG_HOME, "onnx.sock", host)).toBe(
      boundedUnixSocketPath(LONG_HOME, "onnx.sock", host),
    );
  });
});

describe("ensureUnixSocketDir alias ownership (8tbaa)", () => {
  it("refuses an alias owned by another user with a typed error, leaving it in place", () => {
    const home = makeLongHome();
    const socket = boundedUnixSocketPath(home, "onnx.sock", { uid: ownUid() + 1 });
    const alias = dirname(socket);
    cleanups.push(alias);
    // Planted by "someone else": the file is ours on disk, so claim to be a
    // different uid — from that caller's view the alias is foreign-owned.
    symlinkSync(home, alias, "dir");

    expect(() => {
      ensureUnixSocketDir(home, socket, { uid: ownUid() + 1 });
    }).toThrow(UnixSocketDirForeignOwnerError);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it("replaces an own alias that points elsewhere", () => {
    const home = makeLongHome();
    const socket = boundedUnixSocketPath(home, "onnx.sock");
    const alias = dirname(socket);
    cleanups.push(alias);
    symlinkSync(tmpdir(), alias, "dir");

    ensureUnixSocketDir(home, socket);

    expect(readlinkSync(alias)).toBe(home);
  });

  it("removeUnixSocketAlias drops the own alias and leaves a foreign one", () => {
    const home = makeLongHome();
    const socket = boundedUnixSocketPath(home, "onnx.sock");
    const alias = dirname(socket);
    cleanups.push(alias);
    ensureUnixSocketDir(home, socket);

    removeUnixSocketAlias(home, socket, { uid: ownUid() + 1 });
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);

    removeUnixSocketAlias(home, socket);
    expect(() => lstatSync(alias)).toThrow();
  });
});
