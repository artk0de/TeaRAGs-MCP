/**
 * The git-cli adapter spawns whichever git binary `resolveGitExecutable`
 * picked, never a hard-coded `git` from PATH. On macOS the PATH git is
 * typically Homebrew's ad-hoc-signed build, whose every fresh command line an
 * Endpoint Security agent evaluates serially; Apple's `/usr/bin/git` is not
 * throttled. The resolver is replaced with a sentinel path here so the test
 * proves the spawn sites route through it, independent of the host's git.
 */
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { blameFile, createCatFileBatch } from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import type * as GitExecutableModule from "../../../../../../src/core/infra/git-executable.js";

const RESOLVED_GIT = "/resolved/by/test/git";

vi.mock("node:child_process");
vi.mock("../../../../../../src/core/infra/git-executable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecutableModule>()),
  resolveGitExecutable: () => RESOLVED_GIT,
}));

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stdin: EventEmitter & { write: () => boolean; end: () => void };
  kill: () => void;
  exitCode: number | null;
  signalCode: string | null;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.write = () => {
    // Answer the one request as a missing object — the reader resolves "".
    queueMicrotask(() => child.stdout.emit("data", Buffer.from("HEAD:a.ts missing\n")));
    return true;
  };
  stdin.end = () => undefined;
  child.stdin = stdin;
  child.kill = () => undefined;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("git-cli spawn sites use the resolved git executable", () => {
  it("blameFile runs `blame` through the resolved executable", async () => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, "", "");
      return new EventEmitter();
    }) as never);

    await blameFile("/repo", "src/a.ts");

    expect(vi.mocked(execFile).mock.calls[0]?.[0]).toBe(RESOLVED_GIT);
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual(["blame", "--porcelain", "HEAD", "--", "src/a.ts"]);
  });

  it("createCatFileBatch spawns its persistent `cat-file --batch` through the resolved executable", async () => {
    vi.mocked(spawn).mockImplementation((() => fakeChild()) as never);

    const reader = createCatFileBatch("/repo");
    await expect(reader.read("HEAD", "a.ts")).resolves.toBe("");

    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(RESOLVED_GIT);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["cat-file", "--batch"]);
  });
});
