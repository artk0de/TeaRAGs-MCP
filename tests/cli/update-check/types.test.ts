import { describe, expect, it } from "vitest";

import { available, buildChangelogUrl, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

describe("update-check types — factories", () => {
  it("available() produces kind='available' with all fields", () => {
    const s = available("1.23.1", "1.24.0");
    expect(s).toEqual({
      kind: "available",
      current: "1.23.1",
      latest: "1.24.0",
      changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0",
    });
  });

  it("upToDate() produces kind='up-to-date' with current only", () => {
    const s = upToDate("1.23.1");
    expect(s).toEqual({ kind: "up-to-date", current: "1.23.1" });
  });

  it.each(["network", "timeout", "malformed", "cache-miss"] as const)(
    "unavailable('%s') carries the reason verbatim",
    (reason) => {
      const s = unavailable(reason);
      expect(s).toEqual({ kind: "unavailable", reason });
    },
  );

  it("buildChangelogUrl() points at the GitHub release tag", () => {
    expect(buildChangelogUrl("1.24.0")).toBe("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
  });
});

describe("update-check types — input guards", () => {
  it.each(["", "v1.2.3", "1.2", "1.2.3.4", "1.2.3-rc.1", "not-semver"])(
    "buildChangelogUrl rejects non X.Y.Z input: %s",
    (bad) => {
      expect(() => buildChangelogUrl(bad)).toThrow(/expected X\.Y\.Z semver/);
    },
  );

  it("available() throws when current is not semver", () => {
    expect(() => available("not-semver", "1.0.0")).toThrow(/current/);
  });

  it("available() throws when latest is not semver", () => {
    expect(() => available("1.0.0", "")).toThrow(/expected X\.Y\.Z semver/);
  });

  it("UnavailableReason is exhaustively covered", () => {
    const reasons: readonly ("network" | "timeout" | "malformed" | "cache-miss")[] = [
      "network",
      "timeout",
      "malformed",
      "cache-miss",
    ];
    // If a new variant is added without updating this list, TS will complain.
    expect(reasons).toHaveLength(4);
  });
});
