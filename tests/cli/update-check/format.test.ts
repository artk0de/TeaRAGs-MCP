import { describe, expect, it } from "vitest";

import { createColorizer } from "../../../src/cli/infra/color.js";
import { formatForCli, formatForPrime } from "../../../src/cli/update-check/format.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

const plain = createColorizer({ env: { NO_COLOR: "1" }, isTTY: false });
const colored = createColorizer({ env: { FORCE_COLOR: "1" }, isTTY: true });

describe("formatForCli", () => {
  it("renders the 'available' variant with current, latest, changelog", () => {
    const out = formatForCli(available("1.23.1", "1.24.0"), plain);
    expect(out).toContain("1.23.1");
    expect(out).toContain("1.24.0");
    expect(out).toContain("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
  });

  it("renders 'up-to-date' with the current version", () => {
    const out = formatForCli(upToDate("1.23.1"), plain);
    expect(out).toContain("1.23.1");
    expect(out).toContain("up to date");
  });

  it.each(["network", "timeout", "malformed"] as const)("renders 'unavailable' with reason: %s", (reason) => {
    const out = formatForCli(unavailable(reason), plain);
    expect(out.toLowerCase()).toContain("couldn't check");
  });

  it("keeps the plain text byte-identical when the colorizer is disabled", () => {
    expect(formatForCli(available("1.23.1", "1.24.0"), plain)).toBe(
      "tea-rags 1.23.1 → 1.24.0 available.\nchangelog: https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0",
    );
    expect(formatForCli(upToDate("1.23.1"), plain)).toBe("tea-rags 1.23.1 is up to date.");
    expect(formatForCli(unavailable("network"), plain)).toBe(
      "Couldn't check for updates (reason: network). Try again later.",
    );
  });

  it("paints the new version as ok, the changelog label dim and the link brand", () => {
    const out = formatForCli(available("1.23.1", "1.24.0"), colored);
    expect(out).toContain(colored.bold(colored.ok("1.24.0")));
    expect(out).toContain(colored.dim("changelog:"));
    expect(out).toContain(colored.brand("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0"));
  });

  it("paints 'up to date' as ok and an unavailable check as a warning", () => {
    expect(formatForCli(upToDate("1.23.1"), colored)).toBe(colored.ok("tea-rags 1.23.1 is up to date."));
    expect(formatForCli(unavailable("timeout"), colored)).toBe(
      colored.warn("Couldn't check for updates (reason: timeout). Try again later."),
    );
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
