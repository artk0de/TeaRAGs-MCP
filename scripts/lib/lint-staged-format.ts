/**
 * Apply the pre-commit hook's lint-staged commands to pending sources BEFORE a
 * language-version pin is computed (bd tea-rags-mcp-e6xx).
 *
 * The pin (`tests/core/domains/language/capability/version-pins.json`) is a
 * digest of source BYTES, and lint-staged rewrites those bytes at commit time —
 * after `npm run pin:lang-versions` has run. Two commits on the e6xx branch
 * failed their own pin test that way: prettier merged two imports from one
 * module, and `eslint --fix` dropped a redundant type assertion. Running the
 * very same commands first makes the digest the one the commit will carry.
 *
 * The command list is read from `package.json#lint-staged`, never restated
 * here, so a change to the hook's formatting step reaches the pin with it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import picomatch from "picomatch";

export type LintStagedConfig = Record<string, string | string[]>;

/**
 * The commands lint-staged would run on `file`, in order. A pattern without a
 * `/` matches the basename — lint-staged's own rule — so `*.{ts,js}` covers
 * `src/a/b.ts`.
 */
export function lintStagedCommandsFor(file: string, config: LintStagedConfig): string[] {
  const commands: string[] = [];
  for (const [pattern, entry] of Object.entries(config)) {
    const subject = pattern.includes("/") ? file : basename(file);
    if (!picomatch(pattern, { dot: true })(subject)) continue;
    commands.push(...(Array.isArray(entry) ? entry : [entry]));
  }
  return commands;
}

/** The pending paths a version pin can digest: non-test TypeScript under `src/`. */
export function pinnableSourceFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".test.ts"));
}

/** Tracked files changed against HEAD plus untracked ones, repo-relative. */
function pendingPaths(root: string): string[] {
  const git = (args: string[]): string[] =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((line) => line !== "");
  return [
    ...new Set([...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])]),
  ];
}

/**
 * Run lint-staged's commands over the pending pinnable sources, grouped per
 * command as lint-staged groups them. A command that exits non-zero (eslint on
 * an error it cannot fix) is reported, not thrown: the commit will fail on the
 * same error, and the pin is still computed over whatever the fixers did write.
 */
export function formatPendingSourcesAsLintStagedWould(root: string): { files: string[]; failures: string[] } {
  const config = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { "lint-staged"?: LintStagedConfig })[
    "lint-staged"
  ];
  const files = pinnableSourceFiles(pendingPaths(root)).filter((file) => existsSync(join(root, file)));
  if (config === undefined || files.length === 0) return { files, failures: [] };

  const byCommand = new Map<string, string[]>();
  for (const file of files) {
    for (const command of lintStagedCommandsFor(file, config)) {
      const targets = byCommand.get(command) ?? [];
      targets.push(file);
      byCommand.set(command, targets);
    }
  }
  const failures: string[] = [];
  for (const [command, targets] of byCommand) {
    const [bin, ...args] = command.split(" ");
    try {
      execFileSync("npx", [bin, ...args, ...targets], { cwd: root, stdio: "inherit" });
    } catch {
      failures.push(command);
    }
  }
  return { files, failures };
}
