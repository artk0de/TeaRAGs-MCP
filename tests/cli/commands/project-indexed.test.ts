/**
 * `tea-rags project indexed` (bd tea-rags-mcp-ueplg): exit 0 when a file — a
 * `--path`, or a reader operand of a `--command` — is in the index snapshot
 * serving its tree, 1 otherwise, 2 on a usage error. The plugin's
 * PreToolUse(Read|Bash) hook runs it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runProjectIndexed,
  runProjectIndexedArgv,
  type ProjectIndexedDeps,
} from "../../../src/cli/commands/project-indexed.js";

const MATCH = { project: "repo", collectionName: "code_repo", relativePath: "src/a.ts" };

const depsAnswering = (answer: typeof MATCH | null): ProjectIndexedDeps & { asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    findFirstIndexedFile: async (paths) => {
      asked.push([...paths]);
      return Promise.resolve(answer);
    },
  };
};

describe("CLI 'project indexed' command", () => {
  let out: string;

  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 0 and prints the match as JSON for an indexed file", async () => {
    const deps = depsAnswering(MATCH);

    await expect(runProjectIndexed({ paths: ["/repo/src/a.ts"], json: true }, deps)).resolves.toBe(0);
    expect(JSON.parse(out)).toEqual({ indexed: true, ...MATCH });
    expect(deps.asked).toEqual([["/repo/src/a.ts"]]);
  });

  it("exits 1 and prints indexed:false as JSON for a file outside the index", async () => {
    await expect(runProjectIndexed({ paths: ["/repo/package.json"], json: true }, depsAnswering(null))).resolves.toBe(
      1,
    );
    expect(JSON.parse(out)).toEqual({ indexed: false });
  });

  it("prints the tree-relative path without --json on a match, nothing on a miss", async () => {
    await expect(runProjectIndexed({ paths: ["/repo/src/a.ts"] }, depsAnswering(MATCH))).resolves.toBe(0);
    expect(out).toBe("src/a.ts\n");
    out = "";
    await expect(runProjectIndexed({ paths: ["/repo/x.json"] }, depsAnswering(null))).resolves.toBe(1);
    expect(out).toBe("");
  });

  it("asks once for every reader operand of a --command, resolved against --cwd", async () => {
    const deps = depsAnswering(MATCH);

    await expect(
      runProjectIndexed({ paths: [], command: "cat a.rb; sed -n 1,40p b.rb", cwd: "/repo", json: true }, deps),
    ).resolves.toBe(0);
    expect(deps.asked).toEqual([["/repo/a.rb", "/repo/b.rb"]]);
  });

  it("exits 1 without asking when a --command reads no file or cannot be parsed", async () => {
    const deps = depsAnswering(MATCH);

    await expect(runProjectIndexed({ paths: [], command: "git diff | head", cwd: "/repo" }, deps)).resolves.toBe(1);
    await expect(runProjectIndexed({ paths: [], command: "cat $(ls)", cwd: "/repo" }, deps)).resolves.toBe(1);
    expect(deps.asked).toEqual([]);
  });

  it("parses repeated --path, --command, --cwd and --json from a raw argv (the lean entrypoint path)", async () => {
    const deps = depsAnswering(MATCH);

    await expect(
      runProjectIndexedArgv(["--path", "/repo/src/a.ts", "--path", "/repo/b.ts", "--json"], deps),
    ).resolves.toBe(0);
    await expect(runProjectIndexedArgv(["--command", "head x.rb", "--cwd", "/repo"], deps)).resolves.toBe(0);
    expect(deps.asked).toEqual([["/repo/src/a.ts", "/repo/b.ts"], ["/repo/x.rb"]]);
  });

  it("exits 2 without asking when the raw argv carries neither --path nor --command, or an unknown flag", async () => {
    const deps = depsAnswering(MATCH);

    await expect(runProjectIndexedArgv(["--json"], deps)).resolves.toBe(2);
    await expect(runProjectIndexedArgv(["--path", "/a", "--bogus"], deps)).resolves.toBe(2);
    expect(deps.asked).toEqual([]);
  });
});
