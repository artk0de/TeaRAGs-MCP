import { describe, expect, it } from "vitest";

import { primeCommand } from "../../../src/cli/commands/prime.js";

describe("primeCommand", () => {
  it("declares the 'prime <path>' command shape with positional path arg", () => {
    expect(primeCommand.command).toBe("prime <path>");
    expect(primeCommand.describe).toBeTruthy();
  });
});
