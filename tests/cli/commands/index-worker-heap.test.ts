/**
 * The index worker is forked with its own `execArgv`. Without an explicit
 * old-space flag that process stays on Node's ~4 GB default and a large index
 * dies with `JavaScript heap out of memory`.
 */

import { describe, expect, it } from "vitest";

import { INDEX_WORKER_OLD_SPACE_MB, indexWorkerExecArgv } from "../../../src/cli/commands/index-codebase.js";

describe("index worker old-space", () => {
  it("floors a bare launch at 10 GiB", () => {
    expect(INDEX_WORKER_OLD_SPACE_MB).toBe(10240);
    expect(indexWorkerExecArgv([], undefined)).toEqual(["--max-old-space-size=10240"]);
  });

  it("raises a smaller parent flag and keeps unrelated flags", () => {
    expect(indexWorkerExecArgv(["--enable-source-maps", "--max-old-space-size=2048"], undefined)).toEqual([
      "--enable-source-maps",
      "--max-old-space-size=10240",
    ]);
  });

  it("keeps a larger explicit ceiling from execArgv or NODE_OPTIONS", () => {
    expect(indexWorkerExecArgv(["--max-old-space-size", "16384"], undefined)).toEqual(["--max-old-space-size=16384"]);
    expect(indexWorkerExecArgv([], "--max-old-space-size=12288")).toEqual(["--max-old-space-size=12288"]);
  });
});
