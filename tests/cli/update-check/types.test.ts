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
