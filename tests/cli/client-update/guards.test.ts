import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isLinkedGlobalInstall,
  isPidAlive,
  liveIndexWorkers,
  npmGlobalRoot,
} from "../../../src/cli/client-update/guards.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("isLinkedGlobalInstall", () => {
  it("detects a symlinked package dir, and treats a real dir, a missing dir and an unknown root as not linked", async () => {
    dir = mkdtempSync(join(tmpdir(), "guards-"));
    const target = join(dir, "checkout");
    mkdirSync(target);
    symlinkSync(target, join(dir, "tea-rags"));
    expect(await isLinkedGlobalInstall(async () => dir)).toBe(true);

    const real = mkdtempSync(join(tmpdir(), "guards-real-"));
    mkdirSync(join(real, "tea-rags"));
    expect(await isLinkedGlobalInstall(async () => real)).toBe(false);
    rmSync(real, { recursive: true, force: true });

    expect(await isLinkedGlobalInstall(async () => join(dir, "nope"))).toBe(false);
    expect(await isLinkedGlobalInstall(async () => null)).toBe(false);
  });
});

describe("npmGlobalRoot", () => {
  it("returns a non-empty path string or null, never throws", async () => {
    const root = await npmGlobalRoot();
    expect(root === null || (typeof root === "string" && root.length > 0)).toBe(true);
  });
});

describe("liveIndexWorkers / isPidAlive", () => {
  it("keeps only records whose pid answers the probe", () => {
    const records = [{ pid: 1 }, { pid: 2 }] as never[];
    const live = liveIndexWorkers({ list: () => records }, (pid) => pid === 2);
    expect(live).toEqual([{ pid: 2 }]);
  });

  it("reports this process alive and an unused pid dead", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
