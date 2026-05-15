import { describe, expect, it, vi } from "vitest";

import { primeCommand } from "../../../src/cli/commands/prime.js";

vi.mock("../../../src/cli/prime/run-prime.js", () => ({
  runPrime: vi.fn().mockResolvedValue(undefined),
}));

type PrimeHandler = (args: { path?: string; project?: string }) => Promise<void>;

describe("primeCommand", () => {
  it("declares the 'prime [path]' command shape (optional path; --project alternative)", () => {
    expect(primeCommand.command).toBe("prime [path]");
    expect(primeCommand.describe).toBeTruthy();
  });

  it("registers positional 'path' and --project option through the yargs builder", () => {
    // Drive builder() so its option-declaration statements execute.
    const positionalCaptured: { name: string; opts: Record<string, unknown> }[] = [];
    const optionCaptured: { name: string; opts: Record<string, unknown> }[] = [];
    const fakeYargs = {
      positional(name: string, opts: Record<string, unknown>) {
        positionalCaptured.push({ name, opts });
        return this;
      },
      option(name: string, opts: Record<string, unknown>) {
        optionCaptured.push({ name, opts });
        return this;
      },
    };
    type BuilderFn = (y: typeof fakeYargs) => typeof fakeYargs;
    const builder = primeCommand.builder as unknown as BuilderFn;
    const result = builder(fakeYargs);

    expect(result).toBe(fakeYargs);
    expect(positionalCaptured).toHaveLength(1);
    expect(positionalCaptured[0].name).toBe("path");
    expect(positionalCaptured[0].opts.type).toBe("string");
    expect(optionCaptured).toHaveLength(1);
    expect(optionCaptured[0].name).toBe("project");
    expect(optionCaptured[0].opts.type).toBe("string");
  });

  it("forwards path and project to runPrime when the handler runs", async () => {
    const { runPrime } = await import("../../../src/cli/prime/run-prime.js");
    const runPrimeMock = vi.mocked(runPrime);
    runPrimeMock.mockClear();

    await (primeCommand.handler as PrimeHandler)({ path: "/projects/demo" });

    expect(runPrimeMock).toHaveBeenCalledOnce();
    expect(runPrimeMock).toHaveBeenCalledWith({ path: "/projects/demo", project: undefined });
  });
});
