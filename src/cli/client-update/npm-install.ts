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
  /** `output` = npm's captured stdout+stderr, present only when the install ran with `captureOutput`. */
  | { kind: "failed"; exitCode: number; output?: string };

/**
 * Installs `tea-rags@<spec>` globally; `version` is what a successful install
 * reports. npm's output goes to this process's stdio — the terminal for a
 * manual run. `captureOutput` (the background run, whose stdout is the log)
 * pipes it instead: dropped on success, returned with a failure (bd
 * tea-rags-mcp-5o5af — npm's ERESOLVE warnings drowned the log).
 */
export async function runNpmGlobalInstall(
  spawn: typeof nodeSpawn,
  spec: string,
  version: string,
  options: { captureOutput?: boolean } = {},
): Promise<UpdateInstallOutcome> {
  return new Promise((resolve) => {
    // Force postinstall to run even if user's ~/.npmrc has ignore-scripts=true.
    // tea-rags' postinstall (scripts/postinstall.js) is required for proper setup.
    const child = spawn("npm", ["install", "-g", `tea-rags@${spec}`], {
      stdio: options.captureOutput === true ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, npm_config_ignore_scripts: "false" },
    });
    const captured: string[] = [];
    const capture = (chunk: Buffer | string): void => {
      captured.push(String(chunk));
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message)) {
        resolve({ kind: "npm-missing" });
        return;
      }
      resolve({ kind: "spawn-failed", message: err.message });
    });

    // Captured output is complete only once the pipes close; `exit` can precede the last chunk.
    child.on(options.captureOutput === true ? "close" : "exit", (code: number | null) => {
      if (code === 0) {
        resolve({ kind: "installed", version });
        return;
      }
      const output = captured.join("");
      resolve({ kind: "failed", exitCode: code ?? 1, ...(output.length > 0 ? { output } : {}) });
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
