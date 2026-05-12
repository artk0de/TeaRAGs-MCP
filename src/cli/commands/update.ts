import { spawn as nodeSpawn } from "node:child_process";

import type { CommandModule } from "yargs";

import { FileCacheStore } from "../update-check/cache-store.js";
import { UpdateCheckService } from "../update-check/check-service.js";
import { formatForCli } from "../update-check/format.js";
import { NpmRegistryClient } from "../update-check/registry-client.js";
import type { UpdateStatus } from "../update-check/types.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";

type SpawnFn = typeof nodeSpawn;
type ExitFn = (code: number) => void;

export interface RunUpdateDeps {
  service: Pick<UpdateCheckService, "checkForUpdate">;
  spawn: SpawnFn;
  exit: ExitFn;
}

function defaultDeps(): RunUpdateDeps {
  const service = new UpdateCheckService(new PackageJsonVersionSource(), new NpmRegistryClient(), new FileCacheStore());
  return {
    service,
    spawn: nodeSpawn,
    exit: (code) => process.exit(code),
  };
}

/**
 * Pure handler — accepts injected deps so tests can mock the service and
 * the spawn function without touching node:child_process or the real
 * registry.
 */
export async function runUpdateCommand(depsOverride?: Partial<RunUpdateDeps>): Promise<void> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const status = await deps.service.checkForUpdate({ allowNetwork: true, preferCache: false });

  switch (status.kind) {
    case "up-to-date":
      process.stdout.write(`${formatForCli(status)}\n`);
      deps.exit(0);
      return;
    case "unavailable":
      process.stderr.write(`${formatForCli(status)}\n`);
      deps.exit(1);
      return;
    case "available":
      runNpmInstall(status, deps);
  }
}

function runNpmInstall(status: Extract<UpdateStatus, { kind: "available" }>, deps: RunUpdateDeps): void {
  process.stdout.write(`Updating tea-rags ${status.current} → ${status.latest}...\n`);
  // Force postinstall to run even if user's ~/.npmrc has ignore-scripts=true.
  // tea-rags' postinstall (scripts/postinstall.js) is required for proper setup.
  const child = deps.spawn("npm", ["install", "-g", "tea-rags@latest"], {
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_scripts: "false" },
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message)) {
      process.stderr.write("npm not found in PATH. Install Node.js or update tea-rags manually.\n");
      deps.exit(127);
      return;
    }
    process.stderr.write(`Failed to spawn npm: ${err.message}\n`);
    deps.exit(1);
  });

  child.on("exit", (code) => {
    deps.exit(code ?? 1);
  });
}

export const updateCommand: CommandModule<object, object> = {
  command: "update",
  describe: "Check for a newer tea-rags version and install it via npm.",
  handler: async () => {
    await runUpdateCommand();
  },
};
