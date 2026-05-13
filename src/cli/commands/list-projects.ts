import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface Args {
  json?: boolean;
}

export const listProjectsCommand: CommandModule<object, Args> = {
  command: "list-projects",
  describe: "List all registered projects from ~/.tea-rags/registry.json.",
  builder: (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
  handler: (argv) => {
    const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
    const list = new CollectionRegistry(dataDir).list();
    if (argv.json) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return;
    }
    if (list.length === 0) {
      process.stdout.write("(no projects registered)\n");
      return;
    }
    for (const e of list) {
      process.stdout.write(`${e.name ?? "(no name)"}\t${e.collectionName}\t${e.path}\n`);
    }
  },
};
