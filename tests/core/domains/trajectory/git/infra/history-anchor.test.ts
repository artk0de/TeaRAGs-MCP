import { afterEach, describe, expect, it, vi } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import {
  historyNowMs,
  historyWindowSince,
  resolveHistoryAnchorSec,
} from "../../../../../../src/core/domains/trajectory/git/infra/history-anchor.js";
import { isDebug, setDebug } from "../../../../../../src/core/infra/runtime.js";

function adapterReadingHead(readHeadCommitTime: (timeoutMs?: number) => Promise<number>): VcsGitAdapter {
  return { readHeadCommitTime } as unknown as VcsGitAdapter;
}

/** A HEAD read that rejects with an arbitrary value — git wrappers do not always reject with an Error. */
function headReadRejectingWith(reason: unknown): () => Promise<number> {
  return async () => {
    throw reason;
  };
}

const DAY_MS = 86400 * 1000;
const initialDebug = isDebug();

afterEach(() => {
  setDebug(initialDebug);
  vi.restoreAllMocks();
});

describe("resolveHistoryAnchorSec — where git history windows are measured from", () => {
  it("anchors at HEAD's commit time in head mode, forwarding the read timeout", async () => {
    const read = vi.fn(async () => 1_700_000_000);

    await expect(resolveHistoryAnchorSec(adapterReadingHead(read), "head", 2500)).resolves.toBe(1_700_000_000);
    expect(read).toHaveBeenCalledWith(2500);
  });

  it("never touches git in wall-clock mode", async () => {
    const read = vi.fn(async () => 1_700_000_000);

    await expect(resolveHistoryAnchorSec(adapterReadingHead(read), "now")).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("falls back to the wall clock when HEAD's commit time is unreadable, logging why under DEBUG", async () => {
    setDebug(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const anchor = await resolveHistoryAnchorSec(
      adapterReadingHead(async () => {
        throw new Error("fatal: ambiguous argument 'HEAD'");
      }),
      "head",
    );

    expect(anchor).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("HEAD commit time unreadable"),
      "fatal: ambiguous argument 'HEAD'",
    );
  });

  it("falls back silently when the read fails outside DEBUG, including on a non-Error rejection", async () => {
    setDebug(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const anchor = await resolveHistoryAnchorSec(adapterReadingHead(headReadRejectingWith("unborn branch")), "head");

    expect(anchor).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("reports a non-Error rejection verbatim under DEBUG", async () => {
    setDebug(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await resolveHistoryAnchorSec(adapterReadingHead(headReadRejectingWith("unborn branch")), "head");

    expect(log).toHaveBeenCalledWith(expect.any(String), "unborn branch");
  });
});

describe("historyWindowSince — the start of the history window", () => {
  it("measures the window back from the anchor when one is given", () => {
    const anchorSec = 1_700_000_000;

    expect(historyNowMs(anchorSec)).toBe(anchorSec * 1000);
    expect(historyWindowSince(6, anchorSec).getTime()).toBe(anchorSec * 1000 - 6 * 30 * DAY_MS);
  });

  it("treats a non-positive window as the ten-year default, measured from the wall clock without an anchor", () => {
    const now = Date.UTC(2026, 9, 4);
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(historyWindowSince(0).getTime()).toBe(now - 120 * 30 * DAY_MS);
  });
});
