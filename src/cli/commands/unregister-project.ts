import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface Args {
  name: string;
}

export const unregisterProjectCommand: CommandModule<object, Args> = {
  command: "unregister-project",
  describe: "Remove a registered project by name (does not touch Qdrant).",
  builder: (y) => y.option("name", { type: "string", demandOption: true, describe: "Project name to remove" }),
  handler: async (argv) => {
    const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
    const registry = new CollectionRegistry(dataDir);
    const ops = new ProjectRegistryOps({ registry });
    const out = await ops.unregister({ name: argv.name });
    process.stdout.write(out.removed ? `Removed '${argv.name}'\n` : `'${argv.name}' was not registered\n`);
  },
};
