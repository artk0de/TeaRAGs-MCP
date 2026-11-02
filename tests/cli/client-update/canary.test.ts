import { describe, expect, it } from "vitest";

import { selectCanaryRelease } from "../../../src/cli/client-update/canary.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

describe("selectCanaryRelease", () => {
  it("installs latest once a minor/patch release is at least 3 days old", () => {
    const timeline = { latest: "1.51.0", publishedAt: { "1.50.0": ago(20), "1.51.0": ago(3) } };
    expect(selectCanaryRelease("1.50.0", timeline, NOW)).toBe("1.51.0");
  });

  it("skips a too-fresh latest and picks the newest older release that passed its window", () => {
    const timeline = {
      latest: "1.52.0",
      publishedAt: { "1.50.0": ago(30), "1.51.0": ago(5), "1.51.1": ago(4), "1.52.0": ago(1) },
    };
    expect(selectCanaryRelease("1.50.0", timeline, NOW)).toBe("1.51.1");
  });

  it("holds a major bump for 7 days while a minor bump of the same age passes", () => {
    const timeline = { latest: "2.0.0", publishedAt: { "1.50.0": ago(30), "1.51.0": ago(5), "2.0.0": ago(5) } };
    expect(selectCanaryRelease("1.50.0", timeline, NOW)).toBe("1.51.0");
    const aged = { latest: "2.0.0", publishedAt: { "1.50.0": ago(30), "2.0.0": ago(7) } };
    expect(selectCanaryRelease("1.50.0", aged, NOW)).toBe("2.0.0");
  });

  it("returns null when nothing newer than the installed version passed its window", () => {
    const timeline = { latest: "1.51.0", publishedAt: { "1.50.0": ago(30), "1.51.0": ago(2) } };
    expect(selectCanaryRelease("1.50.0", timeline, NOW)).toBeNull();
    expect(selectCanaryRelease("1.51.0", { latest: "1.51.0", publishedAt: { "1.51.0": ago(9) } }, NOW)).toBeNull();
  });

  it("ignores prereleases, the created/modified keys, unparsable dates and versions above latest", () => {
    const timeline = {
      latest: "1.51.0",
      publishedAt: {
        created: ago(400),
        modified: ago(0),
        "1.51.0": "not-a-date",
        "1.52.0-rc.1": ago(10),
        "1.53.0": ago(10),
        "1.50.1": ago(10),
      },
    };
    expect(selectCanaryRelease("1.50.0", timeline, NOW)).toBe("1.50.1");
  });
});
