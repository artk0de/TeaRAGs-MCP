/**
 * `WorkingTreeChangeClock` host defaults that only the real FSEvents test used
 * to reach: the main-checkout probe, the on-disk cookie write/remove and the
 * recursive `fs.watch` binding. The watch itself is faked at the boundary so
 * this runs on every platform; only the platform gate is forced open.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkingTreeChangeClock } from "../../../../../src/core/domains/explore/working-tree/change-clock.js";

const fsWatchMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, watch: fsWatchMock };
});

describe("WorkingTreeChangeClock host defaults", () => {
  const roots: string[] = [];
  afterEach(() => {
    fsWatchMock.mockReset();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function mainCheckout(): string {
    const root = mkdtempSync(join(tmpdir(), "tea-rags-clock-defaults-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    return root;
  }

  it("watches the toplevel recursively, writes a real cookie, vouches once the watch echoes it, and removes the cookie", async () => {
    const root = mainCheckout();
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    fsWatchMock.mockImplementation((_path: string, _options: unknown, callback: typeof listener) => {
      listener = callback;
      return watcher;
    });
    const clock = new WorkingTreeChangeClock({ supported: true, barrierTimeoutMs: 5000, remarkMs: 5000 });

    const pending = clock.settledGeneration(root);
    // The barrier wrote its cookie into .git/: echo it the way FSEvents would.
    await vi.waitFor(() => {
      expect(readdirSync(join(root, ".git")).some((name) => name.startsWith("tea-rags-clock-"))).toBe(true);
    });
    const cookie = readdirSync(join(root, ".git")).find((name) => name.startsWith("tea-rags-clock-")) as string;
    listener?.("rename", Buffer.from(`.git/${cookie}`));

    const first = await pending;
    expect(first).toBeTypeOf("number");
    expect(fsWatchMock).toHaveBeenCalledWith(root, { recursive: true }, expect.any(Function));

    // A null filename (the platform lost track) moves the generation.
    listener?.("change", null);
    const echoNext = clock.settledGeneration(root);
    const cookiesNow = (): string[] =>
      readdirSync(join(root, ".git")).filter((name) => name.startsWith("tea-rags-clock-"));
    await vi.waitFor(() => {
      expect(cookiesNow().some((name) => name !== cookie)).toBe(true);
    });
    const next = cookiesNow().find((name) => name !== cookie) as string;
    listener?.("rename", `.git/${next}`);
    expect(await echoNext).toBeGreaterThan(first as number);

    // Settled barriers clean their cookies off disk.
    await vi.waitFor(() => {
      expect(readdirSync(join(root, ".git")).filter((name) => name.startsWith("tea-rags-clock-"))).toEqual([]);
    });

    clock.close();
    expect(watcher.close).toHaveBeenCalled();
  });

  it("does not vouch for a directory that is not a main checkout (no .git directory)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tea-rags-clock-defaults-"));
    roots.push(root);
    const clock = new WorkingTreeChangeClock({ supported: true });
    expect(await clock.settledGeneration(root)).toBeUndefined();
    expect(fsWatchMock).not.toHaveBeenCalled();
  });
});
