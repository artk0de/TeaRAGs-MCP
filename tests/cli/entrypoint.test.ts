import { describe, expect, it } from "vitest";

import { createCli } from "../../src/cli/create-cli.js";

describe("CLI entrypoint", () => {
  it("should include server command in help output", async () => {
    let helpOutput = "";
    const cli = createCli(["--help"]);

    // Capture help output
    cli.exitProcess(false);
    const originalLog = console.log;
    console.log = (msg: string) => {
      helpOutput += msg;
    };

    try {
      await cli.parseAsync();
    } catch {
      // yargs throws on --help when exitProcess is false
    } finally {
      console.log = originalLog;
    }

    expect(helpOutput).toContain("tea-rags");
    expect(helpOutput).toContain("server");
  });

  it("should require a command (no args = error)", async () => {
    const cli = createCli([]);
    cli.exitProcess(false);

    let failed = false;
    cli.fail(() => {
      failed = true;
    });

    try {
      await cli.parseAsync();
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
  });

  it("should reject unknown commands in strict mode", async () => {
    const cli = createCli(["nonexistent"]);
    cli.exitProcess(false);

    let errorMessage = "";
    cli.fail((msg: string) => {
      errorMessage = msg;
    });

    try {
      await cli.parseAsync();
    } catch {
      // strict mode error
    }

    // yargs strict mode rejects unknown commands
    expect(errorMessage).toMatch(/unknown command|Unknown|nonexistent|Please specify/i);
  });
});
