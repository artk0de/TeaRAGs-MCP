import { describe, expect, it } from "vitest";

import { formatForCli, formatForPrime } from "../../../src/cli/update-check/format.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

describe("formatForCli", () => {
  it("renders the 'available' variant with current, latest, changelog", () => {
    const out = formatForCli(available("1.23.1", "1.24.0"));
    expect(out).toContain("1.23.1");
    expect(out).toContain("1.24.0");
    expect(out).toContain("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
  });

  it("renders 'up-to-date' with the current version", () => {
    const out = formatForCli(upToDate("1.23.1"));
    expect(out).toContain("1.23.1");
    expect(out).toContain("up to date");
  });

  it.each(["network", "timeout", "malformed"] as const)("renders 'unavailable' with reason: %s", (reason) => {
    const out = formatForCli(unavailable(reason));
    expect(out.toLowerCase()).toContain("couldn't check");
  });
});

describe("formatForPrime", () => {
  it("renders the section for 'available' with header, fields, and footer hint", () => {
    const lines = formatForPrime(available("1.23.1", "1.24.0"));
    const joined = lines.join("\n");
    expect(joined).toContain("## tea-rags package");
    expect(joined).toContain("current:");
    expect(joined).toContain("1.23.1");
    expect(joined).toContain("available:");
    expect(joined).toContain("1.24.0");
    expect(joined).toContain("changelog:");
    expect(joined).toContain("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
    expect(joined).toContain("run `tea-rags update`");
  });

  it("returns an empty array for 'up-to-date' (section omitted)", () => {
    expect(formatForPrime(upToDate("1.23.1"))).toEqual([]);
  });

  it.each(["network", "timeout", "malformed", "cache-miss"] as const)(
    "returns an empty array for 'unavailable(%s)' (section omitted)",
    (reason) => {
      expect(formatForPrime(unavailable(reason))).toEqual([]);
    },
  );
});
