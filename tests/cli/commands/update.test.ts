import EventEmitter from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runUpdateCommand } from "../../../src/cli/commands/update.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

const stdoutMock = vi.fn();
const stderrMock = vi.fn();
const exitMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
const stderrOriginal = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutMock.mockReset();
  stderrMock.mockReset();
  exitMock.mockReset();
  process.stdout.write = stdoutMock as unknown as typeof process.stdout.write;
  process.stderr.write = stderrMock as unknown as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutOriginal;
  process.stderr.write = stderrOriginal;
});

function makeService(status: ReturnType<typeof available>): UpdateCheckService {
  return {
    checkForUpdate: vi.fn().mockResolvedValue(status),
  } as unknown as UpdateCheckService;
}

function makeSpawn(behavior: { exitCode?: number | null; errorEvent?: Error }) {
  return vi.fn().mockImplementation(() => {
    const ee = new EventEmitter() as EventEmitter & { kill?: () => void };
    setImmediate(() => {
      if (behavior.errorEvent) {
        ee.emit("error", behavior.errorEvent);
        return;
      }
      ee.emit("exit", behavior.exitCode ?? 0);
    });
    return ee;
  });
}

describe("runUpdateCommand", () => {
  it("prints up-to-date message and exits 0", async () => {
    await runUpdateCommand({
      service: makeService(upToDate("1.23.1") as unknown as ReturnType<typeof available>),
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(stdoutMock).toHaveBeenCalled();
    expect(stdoutMock.mock.calls[0][0]).toContain("up to date");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("on 'available', prints upgrade message and spawns npm install -g tea-rags@latest", async () => {
    const spawn = makeSpawn({ exitCode: 0 });
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn,
      exit: exitMock,
    });
    // Wait for setImmediate to flush the exit event.
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "tea-rags@latest"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("forwards non-zero npm exit code", async () => {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ exitCode: 7 }),
      exit: exitMock,
    });
    await new Promise((r) => setImmediate(r));
    expect(exitMock).toHaveBeenCalledWith(7);
  });

  it("on 'unavailable', prints to stderr and exits 1", async () => {
    await runUpdateCommand({
      service: makeService(unavailable("network") as unknown as ReturnType<typeof available>),
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(stderrMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls[0][0].toLowerCase()).toContain("couldn't check");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("on spawn 'error' event (npm not in PATH), prints helpful stderr and exits 127", async () => {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ errorEvent: new Error("ENOENT") }),
      exit: exitMock,
    });
    await new Promise((r) => setImmediate(r));
    expect(stderrMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls.some((c) => String(c[0]).includes("npm not found"))).toBe(true);
    expect(exitMock).toHaveBeenCalledWith(127);
  });

  it("calls service with allowNetwork=true and preferCache=false (live HTTP)", async () => {
    const svc = makeService(upToDate("1.23.1") as unknown as ReturnType<typeof available>);
    await runUpdateCommand({
      service: svc,
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(svc.checkForUpdate).toHaveBeenCalledWith({
      allowNetwork: true,
      preferCache: false,
    });
  });
});
