/**
 * Runs the oracle's own Python unit tests inside the suite (bd
 * tea-rags-mcp-w205u, E5.0c).
 *
 * `compose_symbol_id` is Python, so its assertions cannot live in vitest — but
 * a Python test nothing spawns is a test nobody runs, and the defect it pins
 * (the whole enclosing scope joined with `"."`, so a def nested in a method read
 * `Cls.method#nested` where the walker composes `Cls#method#nested`) survived
 * the fixture corpus precisely because no gate looked at it. This spawns
 * `scripts/py-oracle/test_compose_symbol_id.py` through the SAME `uv` launcher
 * `JEDI_LAUNCHER` uses, and fails on a non-zero exit with the interpreter's own
 * report attached.
 *
 * Skipped when `uv` is absent, exactly as `jedi-oracle-spawn.test.ts` is — a
 * machine without the toolchain must not fail the suite for lacking it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const uvAvailable = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!uvAvailable)("scripts/py-oracle/test_compose_symbol_id.py", () => {
  it("passes under the oracle's own interpreter", () => {
    const child = spawnSync(
      "uv",
      [
        "run",
        "--no-project",
        "--python",
        "3.13",
        "--with",
        "jedi==0.20.0",
        "python",
        join(REPO_ROOT, "scripts", "py-oracle", "test_compose_symbol_id.py"),
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  }, 180_000);
});
