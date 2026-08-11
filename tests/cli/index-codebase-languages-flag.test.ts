/**
 * yargs-level parsing for `--languages`, plus its value parser.
 *
 * Same trap as `--force-enrichments`: a flag that greedily consumes arguments
 * swallows the command's positional `[path]`, and no unit test of the value
 * parser can see that — it only shows up once yargs assembles the command.
 */

import { describe, expect, it } from "vitest";
import yargs from "yargs";

import { indexCodebaseCommand, parseLanguageSelectors } from "../../src/cli/commands/index-codebase.js";

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

describe("parseLanguageSelectors", () => {
  it("returns undefined when the flag was never passed", () => {
    // Undefined and empty mean different things downstream: absent is "whole
    // index", empty is a mistake the facade refuses.
    expect(parseLanguageSelectors(undefined)).toBeUndefined();
  });

  it("splits a comma-separated list", () => {
    expect(parseLanguageSelectors("typescript,ruby")).toEqual(["typescript", "ruby"]);
  });

  it("tolerates spaces after commas", () => {
    expect(parseLanguageSelectors("typescript, ruby")).toEqual(["typescript", "ruby"]);
  });

  it("drops empty entries from a trailing comma", () => {
    expect(parseLanguageSelectors("ruby,")).toEqual(["ruby"]);
  });

  it("yields an empty list for a blank value, so the facade can refuse it", () => {
    expect(parseLanguageSelectors("")).toEqual([]);
  });
});

describe("--languages flag parsing", () => {
  it("keeps the positional path out of the flag's value", () => {
    const argv = parse(["index-codebase", "/repo", "--languages", "typescript"]);
    expect(argv.path).toBe("/repo");
    expect(argv.languages).toBe("typescript");
  });

  it("keeps the positional path when the flag comes first", () => {
    const argv = parse(["index-codebase", "--languages", "typescript", "/repo"]);
    expect(argv.path).toBe("/repo");
  });

  it("accepts --languages together with --force", () => {
    expect(() => parse(["index-codebase", "--force", "--languages", "ruby"])).not.toThrow();
  });

  it("accepts --languages together with --force-enrichments", () => {
    expect(() => parse(["index-codebase", "--force-enrichments", "codegraph", "--languages", "ruby"])).not.toThrow();
  });

  it("requires a value", () => {
    expect(() => parse(["index-codebase", "--languages"])).toThrow();
  });
});
