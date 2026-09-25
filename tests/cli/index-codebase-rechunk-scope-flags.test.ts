/**
 * The scoped-force flags of `index-codebase` (bd tea-rags-mcp-j4oww):
 * `--path-pattern`, `--test-file`, `--file-extension`, `--files`. With
 * `--force` they re-chunk the selection in place; the flags map one-to-one onto
 * `IndexOptions`, and the drift report's `Run:` line is written in them.
 */

import { describe, expect, it } from "vitest";
import yargs from "yargs";

import { buildIndexOptions, indexCodebaseCommand } from "../../src/cli/commands/index-codebase.js";
import { renderRechunkFlags } from "../../src/core/domains/maintenance/drift/remedy.js";

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

describe("scoped-force flags", () => {
  it("map onto IndexOptions", () => {
    const argv = parse([
      "index-codebase",
      "/repo",
      "--force",
      "--test-file",
      "only",
      "--path-pattern",
      "spec/**",
      "--file-extension",
      ".rb, rake",
      "--files",
      "spec/a_spec.rb,spec/b_spec.rb",
      "--languages",
      "ruby",
    ]);

    expect(argv.path).toBe("/repo");
    expect(buildIndexOptions(argv as never)).toEqual({
      forceReindex: true,
      languages: ["ruby"],
      testFile: "only",
      pathPattern: "spec/**",
      fileExtensions: [".rb", "rake"],
      files: ["spec/a_spec.rb", "spec/b_spec.rb"],
    });
  });

  it("leave IndexOptions untouched when absent", () => {
    expect(buildIndexOptions(parse(["index-codebase", "--force"]) as never)).toEqual({ forceReindex: true });
  });

  it("refuse a --test-file value other than only or exclude", () => {
    expect(() => parse(["index-codebase", "--force", "--test-file", "include"])).toThrow();
  });

  it("parse back exactly what the drift report renders", () => {
    const rendered = renderRechunkFlags({
      testFile: "only",
      pathPattern: "spec/**",
      fileExtensions: [".rb"],
      languages: ["ruby", "typescript"],
    });
    const tokens = [
      "index-codebase",
      "--force",
      ...rendered
        .trim()
        .split(" ")
        .map((t) => t.replace(/^'|'$/g, "")),
    ];

    expect(buildIndexOptions(parse(tokens) as never)).toEqual({
      forceReindex: true,
      languages: ["ruby", "typescript"],
      testFile: "only",
      pathPattern: "spec/**",
      fileExtensions: [".rb"],
    });
  });
});
