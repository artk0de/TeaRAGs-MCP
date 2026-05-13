import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface RegisterProjectArgs {
  path: string;
  name: string;
}

/** Resolve the data directory used by the local registry. */
function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export const registerProjectCommand: CommandModule<object, RegisterProjectArgs> = {
  command: "register-project",
  describe: "Register a name for a project path in the local registry.",
  builder: (yargs) =>
    yargs
      .option("path", {
        type: "string",
        demandOption: true,
        describe: "Absolute path to the project root",
      })
      .option("name", {
        type: "string",
        demandOption: true,
        describe: "Short name to register (regex /^[a-z0-9][a-z0-9_-]{0,63}$/)",
      }),
  handler: async (argv) => {
    const registry = new CollectionRegistry(resolveDataDir());
    const ops = new ProjectRegistryOps({ registry });
    try {
      const out = await ops.register({ path: argv.path, name: argv.name });
      process.stdout.write(
        `Registered '${argv.name}' -> ${out.collectionName}${out.alreadyIndexed ? " (already indexed)" : ""}\n`,
      );
    } catch (err) {
      process.stderr.write(`register-project failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  },
};
