import { describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: vi.fn(),
}));

describe("runPrime — project not registered", () => {
  it("writes a path-not-found placeholder mentioning the unknown project", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((m: string) => {
      writes.push(String(m));
      return true;
    }) as never;
    try {
      await runPrime({ project: "this-project-does-not-exist-anywhere" });
    } finally {
      process.stdout.write = orig;
    }
    const out = writes.join("");
    expect(out).toContain("not registered");
    expect(out).toContain("this-project-does-not-exist-anywhere");
  });

  it("writes path-not-found placeholder when neither path nor project provided", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((m: string) => {
      writes.push(String(m));
      return true;
    }) as never;
    try {
      await runPrime({});
    } finally {
      process.stdout.write = orig;
    }
    expect(writes.join("")).toContain("no path provided");
  });
});
