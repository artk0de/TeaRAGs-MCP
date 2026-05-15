import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(process.cwd(), "scripts", "install-fish-completion.js");

/**
 * Runs the postinstall script in a forked child with the given XDG_CONFIG_HOME
 * override so we can assert against a temp directory instead of `~/.config`.
 */
function runScript(env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("node", [SCRIPT_PATH], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 0,
  };
}

function hasFishOnHost(): boolean {
  try {
    execSync("command -v fish", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("scripts/install-fish-completion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fish-comp-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a completion file when fish is present (uses XDG_CONFIG_HOME)", () => {
    if (!hasFishOnHost()) {
      // CI / sandbox without fish — we can't truly verify the install path.
      // Exit cleanly; the "no fish → no-op" case is covered below by stubbing PATH.
      return;
    }
    runScript({ XDG_CONFIG_HOME: dir });
    const target = join(dir, "fish", "completions", "tea-rags.fish");
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, "utf8");
    expect(body).toContain("# tea-rags-fish-completion-v2");
    expect(body).toContain("__tea_rags_complete");
    expect(body).toContain("complete -c tea-rags -f");
    // Per-option file completion override for --path so file completion
    // still works at that position.
    expect(body).toContain("complete -c tea-rags -l path -r -F");
  });

  it("is a no-op when fish is not on PATH", () => {
    // PATH set to an empty real directory — `command -v fish` will fail.
    runScript({ XDG_CONFIG_HOME: dir, PATH: dir });
    const target = join(dir, "fish", "completions", "tea-rags.fish");
    expect(existsSync(target)).toBe(false);
  });

  it("overwrites an existing tea-rags-managed completion file", () => {
    if (!hasFishOnHost()) return;
    const completionsDir = join(dir, "fish", "completions");
    const target = join(completionsDir, "tea-rags.fish");
    // Pre-seed an older managed version.
    execSync(`mkdir -p ${completionsDir}`);
    writeFileSync(target, "# tea-rags-fish-completion-v1\n# old content\n");

    runScript({ XDG_CONFIG_HOME: dir });

    const body = readFileSync(target, "utf8");
    expect(body).toContain("__tea_rags_complete");
    expect(body).not.toContain("old content");
  });

  it("leaves a user-written tea-rags.fish alone (no marker header)", () => {
    if (!hasFishOnHost()) return;
    const completionsDir = join(dir, "fish", "completions");
    const target = join(completionsDir, "tea-rags.fish");
    const userContent = "# user-managed completion\ncomplete -c tea-rags -d 'manual'\n";
    execSync(`mkdir -p ${completionsDir}`);
    writeFileSync(target, userContent);

    const result = runScript({ XDG_CONFIG_HOME: dir });

    // Untouched.
    expect(readFileSync(target, "utf8")).toBe(userContent);
    // Friendly warning on stderr.
    expect(result.stderr).toMatch(/not written by tea-rags/);
  });
});
