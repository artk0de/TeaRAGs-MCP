/**
 * `npm install -g tea-rags@<spec>` — shared by the manual `tea-rags update`
 * (spec `latest`) and the background client update (an exact canary-eligible
 * version).
 */

import type { spawn as nodeSpawn } from "node:child_process";

export type UpdateInstallOutcome =
  | { kind: "installed"; version: string }
  | { kind: "not-requested" }
  | { kind: "npm-missing" }
  | { kind: "spawn-failed"; message: string }
  | { kind: "failed"; exitCode: number };

/**
 * Installs `tea-rags@<spec>` globally; `version` is what a successful install
 * reports. npm's output goes to this process's stdio — the terminal for a
 * manual run, the log file for a background one.
 */
export async function runNpmGlobalInstall(
  spawn: typeof nodeSpawn,
  spec: string,
  version: string,
): Promise<UpdateInstallOutcome> {
  return new Promise((resolve) => {
    // Force postinstall to run even if user's ~/.npmrc has ignore-scripts=true.
    // tea-rags' postinstall (scripts/postinstall.js) is required for proper setup.
    const child = spawn("npm", ["install", "-g", `tea-rags@${spec}`], {
      stdio: "inherit",
      env: { ...process.env, npm_config_ignore_scripts: "false" },
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message)) {
        resolve({ kind: "npm-missing" });
        return;
      }
      resolve({ kind: "spawn-failed", message: err.message });
    });

    child.on("exit", (code) => {
      resolve(code === 0 ? { kind: "installed", version } : { kind: "failed", exitCode: code ?? 1 });
    });
  });
}

export function installExitCode(install: UpdateInstallOutcome): number {
  switch (install.kind) {
    case "npm-missing":
      return 127;
    case "spawn-failed":
      return 1;
    case "failed":
      return install.exitCode;
    case "installed":
    case "not-requested":
      return 0;
  }
}
