/**
 * The query-time half of `TRAJECTORY_GIT_ANCHOR` (bd tea-rags-mcp-zwu7m): an
 * index's history clock is read from the env snapshot it was STAMPED with,
 * and `now` is the default for every value but an explicit `head`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolveIndexHistoryAnchorSec,
  stampedHistoryAnchorMode,
} from "../../../../../../src/core/domains/trajectory/git/infra/history-anchor.js";

describe("stampedHistoryAnchorMode", () => {
  it("reads head only when the snapshot stamps it explicitly", () => {
    expect(stampedHistoryAnchorMode({ TRAJECTORY_GIT_ANCHOR: "head" })).toBe("head");
  });

  it("reads now for a now stamp, an absent key, an absent snapshot and an unknown value", () => {
    expect(stampedHistoryAnchorMode({ TRAJECTORY_GIT_ANCHOR: "now" })).toBe("now");
    expect(stampedHistoryAnchorMode({ OTHER: "x" })).toBe("now");
    expect(stampedHistoryAnchorMode(undefined)).toBe("now");
    expect(stampedHistoryAnchorMode({ TRAJECTORY_GIT_ANCHOR: "HEAD " })).toBe("now");
  });
});

describe("resolveIndexHistoryAnchorSec", () => {
  it("head + an indexed commit → that commit's time", async () => {
    const read = vi.fn().mockResolvedValue(1_500_000_000);
    expect(await resolveIndexHistoryAnchorSec("head", "abc123", read)).toBe(1_500_000_000);
    expect(read).toHaveBeenCalledWith("abc123");
  });

  it("now never reads git and answers the wall clock (undefined)", async () => {
    const read = vi.fn();
    expect(await resolveIndexHistoryAnchorSec("now", "abc123", read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("head without an indexed commit → wall clock", async () => {
    const read = vi.fn();
    expect(await resolveIndexHistoryAnchorSec("head", undefined, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("head whose commit time is unreadable → wall clock, never a failure", async () => {
    const read = vi.fn().mockRejectedValue(new Error("bad object"));
    expect(await resolveIndexHistoryAnchorSec("head", "gone", read)).toBeUndefined();
  });
});
