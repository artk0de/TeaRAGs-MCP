/**
 * `tea-rags llama-server install` — download llama-server from the pinned
 * llama.cpp release for this machine's OS, arch and GPU backend into
 * `<data dir>/llama.cpp/<build>-<backend>/`, and print the binary path.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { detectLlamaServerBackend, downloadLlamaServer, type LlamaServerBackend } from "../../core/api/index.js";

export const LLAMA_SERVER_INSTALL_BACKENDS = ["auto", "metal", "cpu", "cuda", "vulkan", "rocm"] as const;
export type LlamaServerInstallBackendChoice = (typeof LLAMA_SERVER_INSTALL_BACKENDS)[number];

export interface LlamaServerInstallArgs {
  backend?: LlamaServerInstallBackendChoice;
}

export interface LlamaServerInstallDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  run: (cmd: string, args: string[]) => Promise<void>;
  /** Absolute path of `cmd` on PATH, null when absent. */
  which: (cmd: string) => string | null;
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
}

/** Install (or reuse) llama-server; the LAST printed line is the binary path. */
export async function runLlamaServerInstall(args: LlamaServerInstallArgs, deps: LlamaServerInstallDeps): Promise<void> {
  const choice = args.backend ?? "auto";
  const backend: LlamaServerBackend =
    choice === "auto"
      ? detectLlamaServerBackend(deps.platform, deps.arch, { which: (cmd) => deps.which(cmd) !== null })
      : choice;
  const dataDir = deps.env.TEA_RAGS_DATA_DIR ?? join(deps.home, ".tea-rags");
  deps.out(`llama-server install: ${deps.platform}-${deps.arch} ${backend}${choice === "auto" ? " (detected)" : ""}`);
  const path = await downloadLlamaServer(
    { dataDir, platform: deps.platform, arch: deps.arch, backend },
    { fetch: deps.fetch, run: deps.run },
  );
  deps.out(path);
}

/** PATH lookup without spawning; PATHEXT extensions on Windows. */
function whichOnPath(cmd: string): string | null {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${cmd}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const execFileAsync = promisify(execFile);

export function productionLlamaServerInstallDeps(): LlamaServerInstallDeps {
  return {
    fetch: async (input, init) => fetch(input, init),
    run: async (cmd, args) => {
      await execFileAsync(cmd, args);
    },
    which: whichOnPath,
    out: (line) => process.stdout.write(`${line}\n`),
    env: process.env,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
  };
}
