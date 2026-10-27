import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachDaemonRef,
  bindDaemonRefRelease,
  countLiveDaemonRefs,
  detachDaemonRef,
  seedDaemonRefs,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon-refs.js";

const LIVE = 4242;
const OTHER_LIVE = 5151;
const DEAD = 6363;

const alive = (pid: number): boolean => pid !== DEAD;

describe("daemon refs as a live-pid multiset", () => {
  let tempDir: string;
  let refsFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-refs-"));
    refsFile = join(tempDir, "daemon.refs");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("counts zero when the refs file is missing", () => {
    expect(countLiveDaemonRefs(refsFile, alive)).toBe(0);
  });

  it("drops the ref of every attached process that has exited", () => {
    for (let i = 0; i < 25; i++) attachDaemonRef(refsFile, DEAD, alive);

    expect(countLiveDaemonRefs(refsFile, alive)).toBe(0);
  });

  it("keeps one ref per attach of a live process", () => {
    attachDaemonRef(refsFile, LIVE, alive);
    attachDaemonRef(refsFile, LIVE, alive);
    attachDaemonRef(refsFile, OTHER_LIVE, alive);

    expect(countLiveDaemonRefs(refsFile, alive)).toBe(3);
  });

  it("prunes exited holders when a new process attaches", () => {
    attachDaemonRef(refsFile, DEAD, alive);

    expect(attachDaemonRef(refsFile, LIVE, alive)).toBe(1);
  });

  it("detaches one ref of the calling process, not all of them", () => {
    attachDaemonRef(refsFile, LIVE, alive);
    attachDaemonRef(refsFile, LIVE, alive);

    expect(detachDaemonRef(refsFile, LIVE, alive)).toBe(1);
  });

  it("leaves another process's ref in place on detach", () => {
    attachDaemonRef(refsFile, OTHER_LIVE, alive);

    expect(detachDaemonRef(refsFile, LIVE, alive)).toBe(1);
  });

  it("writes the live count on the first line, so an integer reader sees the same count", () => {
    attachDaemonRef(refsFile, LIVE, alive);
    attachDaemonRef(refsFile, OTHER_LIVE, alive);

    expect(parseInt(readFileSync(refsFile, "utf-8").trim(), 10)).toBe(2);
  });

  it("writes an empty set as 0, so an integer reader sees the daemon idle", () => {
    attachDaemonRef(refsFile, LIVE, alive);
    detachDaemonRef(refsFile, LIVE, alive);

    expect(readFileSync(refsFile, "utf-8").trim()).toBe("0");
  });

  describe("legacy bare-integer refs", () => {
    it("keeps them as holders it cannot prune", () => {
      writeFileSync(refsFile, "3", "utf-8");

      expect(countLiveDaemonRefs(refsFile, alive)).toBe(3);
    });

    it("adds an attach on top of them", () => {
      writeFileSync(refsFile, "3", "utf-8");

      expect(attachDaemonRef(refsFile, LIVE, alive)).toBe(4);
    });

    it("takes a detach without a recorded pid from them", () => {
      writeFileSync(refsFile, "3", "utf-8");

      expect(detachDaemonRef(refsFile, LIVE, alive)).toBe(2);
    });

    it("keeps holders an integer writer folded into the count", () => {
      attachDaemonRef(refsFile, LIVE, alive);
      const legacyIncrement = parseInt(readFileSync(refsFile, "utf-8").trim(), 10) + 1;
      writeFileSync(refsFile, String(legacyIncrement), "utf-8");

      expect(countLiveDaemonRefs(refsFile, alive)).toBe(2);
    });
  });

  it("seeds a freshly spawned daemon with the spawner as its only holder", () => {
    writeFileSync(refsFile, "25", "utf-8");

    seedDaemonRefs(refsFile, LIVE);

    expect(countLiveDaemonRefs(refsFile, alive)).toBe(1);
  });
});

describe("bindDaemonRefRelease", () => {
  it("releases once however many times it is called", () => {
    const detach = vi.fn(() => 0);
    const release = bindDaemonRefRelease(detach, { on: vi.fn(), off: vi.fn() });

    release();
    release();

    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("releases when the process exits without an explicit release", () => {
    const detach = vi.fn(() => 0);
    let onExit: (() => void) | undefined;
    bindDaemonRefRelease(detach, {
      on: (listener) => {
        onExit = listener;
      },
      off: vi.fn(),
    });

    onExit?.();

    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("stops listening for exit once released explicitly", () => {
    const off = vi.fn();
    const release = bindDaemonRefRelease(
      vi.fn(() => 0),
      { on: vi.fn(), off },
    );

    release();

    expect(off).toHaveBeenCalledTimes(1);
  });
});
