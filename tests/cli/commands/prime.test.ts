import { describe, expect, it } from "vitest";

import { primeCommand } from "../../../src/cli/commands/prime.js";

describe("primeCommand", () => {
  it("declares the 'prime [path]' command shape (optional path; --project alternative)", () => {
    expect(primeCommand.command).toBe("prime [path]");
    expect(primeCommand.describe).toBeTruthy();
  });
});
