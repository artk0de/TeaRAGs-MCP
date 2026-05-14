import { describe, expect, it } from "vitest";

import { createCli } from "../../src/cli/create-cli.js";

describe("createCli registration", () => {
  it("registers the 'doctor' command", async () => {
    const help = await new Promise<string>((resolve) => {
      const cli = createCli([]);
      void cli
        .exitProcess(false)
        .fail(() => undefined)
        .parse("--help", (_err: Error | null, _argv: unknown, output: string) => {
          resolve(output ?? "");
        });
    });
    expect(help).toMatch(/\bdoctor\b/);
  });
});
