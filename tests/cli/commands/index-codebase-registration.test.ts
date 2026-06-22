import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli/create-cli.js";

describe("index-codebase command registration", () => {
  it("registers the 'index-codebase' command", async () => {
    const help = await new Promise<string>((resolve) => {
      const cli = createCli([]);
      void cli
        .exitProcess(false)
        .fail(() => undefined)
        .parse("--help", (_err: Error | null, _argv: unknown, output: string) => {
          resolve(output ?? "");
        });
    });
    expect(help).toMatch(/\bindex-codebase\b/);
  });
});
