import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lean, heavy } = vi.hoisted(() => ({ lean: vi.fn(async () => 0), heavy: vi.fn(async () => undefined) }));
vi.mock("../../src/cli/commands/prime-agent.js", () => ({ runPrimeAgentArgv: lean }));
vi.mock("../../src/cli/create-cli.js", () => ({ createCli: () => ({ parseAsync: heavy }) }));
const original = process.argv;
beforeEach(() => {
  vi.resetModules();
  lean.mockClear();
  heavy.mockClear();
});
afterEach(() => {
  process.argv = original;
});

describe("prime CLI dispatch", () => {
  it("dispatches prime --agent before the heavy command table is imported", async () => {
    process.argv = ["node", "tea-rags", "prime", "--agent", "/repo"];
    await import("../../src/cli/index.js");
    await vi.waitFor(() => {
      expect(lean).toHaveBeenCalledWith(["--agent", "/repo"]);
    });
    expect(heavy).not.toHaveBeenCalled();
  });
  it.each([
    ["prime", "/repo"],
    ["prime", "--agent", "--full", "/repo"],
    ["prime", "--agent", "--help"],
  ])("preserves the normal human/full/help path: %s", async (...argv) => {
    process.argv = ["node", "tea-rags", ...argv];
    await import("../../src/cli/index.js");
    await vi.waitFor(() => {
      expect(heavy).toHaveBeenCalledTimes(1);
    });
    expect(lean).not.toHaveBeenCalled();
  });
});
