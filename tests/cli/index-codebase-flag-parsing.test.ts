/**
 * yargs-level parsing for index-codebase flags.
 *
 * These assertions exist because a unit test of the value parser cannot see
 * how yargs ASSEMBLES the command. `--force` carries `default: false`, and
 * yargs' `.conflicts()` treats a key that has a default as present — so a
 * naive `.conflicts("force", "force-enrichments")` rejected every
 * `--force-enrichments` run with "mutually exclusive", even though the user
 * never typed `--force`. Caught only on the first live run.
 */

import { describe, expect, it } from "vitest";
import yargs from "yargs";

import { indexCodebaseCommand } from "../../src/cli/commands/index-codebase.js";

/** Parse argv through the real command definition, surfacing errors as throws. */
function parse(argv: string[]): Record<string, unknown> {
  let failure: string | undefined;
  const parsed = yargs([])
    .command({ ...indexCodebaseCommand, handler: () => undefined })
    .exitProcess(false)
    .fail((msg: string) => {
      failure = msg;
    })
    .parse(argv) as Record<string, unknown>;
  if (failure !== undefined) throw new Error(failure);
  return parsed;
}

describe("index-codebase flag parsing", () => {
  it("accepts --force-enrichments on its own", () => {
    expect(() => parse(["index-codebase", "--force-enrichments", "git"])).not.toThrow();
  });

  it("accepts --force on its own", () => {
    expect(() => parse(["index-codebase", "--force"])).not.toThrow();
  });

  it("still rejects the two force flags together", () => {
    expect(() => parse(["index-codebase", "--force", "--force-enrichments", "git"])).toThrow(/mutually exclusive/i);
  });

  it("keeps the positional path out of the flag's value", () => {
    // The flag takes exactly one argument; without nargs yargs would happily
    // swallow the following positional as the selector list.
    const argv = parse(["index-codebase", "--force-enrichments", "git", "/some/repo"]);

    expect(argv["force-enrichments"]).toBe("git");
    expect(argv.path).toBe("/some/repo");
  });

  it("carries a comma-separated selector list through untouched", () => {
    const argv = parse(["index-codebase", "--force-enrichments", "git,codegraph"]);

    expect(argv["force-enrichments"]).toBe("git,codegraph");
  });

  it("leaves force false when neither flag is given", () => {
    const argv = parse(["index-codebase"]);

    expect(argv.force).toBe(false);
    expect(argv["force-enrichments"]).toBeUndefined();
  });
});
