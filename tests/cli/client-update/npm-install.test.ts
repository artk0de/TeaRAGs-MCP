import EventEmitter from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runNpmGlobalInstall } from "../../../src/cli/client-update/npm-install.js";

function fakeSpawn(exitCode: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const spawn = vi.fn(() => {
    queueMicrotask(() => {
      // `exit` before the last chunk, as Node may order them; `close` follows the drained pipes.
      child.stderr.emit("data", Buffer.from("npm warn ERESOLVE overriding peer dependency\n"));
      child.emit("exit", exitCode);
      child.stdout.emit("data", Buffer.from("added 1 package\n"));
      child.emit("close", exitCode);
    });
    return child;
  });
  return spawn;
}

describe("runNpmGlobalInstall — captured output (5o5af)", () => {
  it("pipes npm's stdio instead of inheriting it, so a successful install writes nothing to the log", async () => {
    const spawn = fakeSpawn(0);
    const outcome = await runNpmGlobalInstall(spawn as never, "1.51.0", "1.51.0", { captureOutput: true });
    expect(outcome).toEqual({ kind: "installed", version: "1.51.0" });
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { stdio: unknown }];
    expect(command).toBe("npm");
    expect(args).toEqual(["install", "-g", "tea-rags@1.51.0"]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("returns the captured output with a failed install", async () => {
    const outcome = await runNpmGlobalInstall(fakeSpawn(1) as never, "1.51.0", "1.51.0", { captureOutput: true });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.output : undefined).toContain("npm warn ERESOLVE");
    expect(outcome.kind === "failed" ? outcome.output : undefined).toContain("added 1 package");
  });

  it("keeps inheriting stdio for the manual update", async () => {
    const spawn = fakeSpawn(0);
    await runNpmGlobalInstall(spawn as never, "latest", "1.51.0");
    const options = (spawn.mock.calls[0] as unknown as [string, string[], { stdio: unknown }])[2];
    expect(options.stdio).toBe("inherit");
  });
});
