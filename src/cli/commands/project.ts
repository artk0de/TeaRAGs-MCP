import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { CollectionRegistry } from "../../core/api/public/index.js";

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export interface ProjectExistArgs {
  path?: string;
  name?: string;
  printName?: boolean;
  json?: boolean;
}

export function runProjectExist(args: ProjectExistArgs): void {
  const registry = new CollectionRegistry(resolveDataDir());
  const entry = args.path ? registry.findByPath(resolve(args.path)) : registry.findByName(args.name ?? "");
  const exists = entry !== null;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ exists, name: entry?.name ?? null })}\n`);
  } else if (args.printName && entry) {
    process.stdout.write(`${entry.name ?? ""}\n`);
  }
  process.exit(exists ? 0 : 1);
}

const existCommand: CommandModule<object, ProjectExistArgs> = {
  command: "exist",
  describe: "Check whether a path or name is a registered tea-rags project (exit 0 = yes, 1 = no)",
  builder: (y) =>
    y
      .option("path", { type: "string", describe: "Project path to check" })
      .option("name", { type: "string", describe: "Project alias to check" })
      .option("print-name", {
        type: "boolean",
        default: false,
        describe: "Print the alias on match",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Emit {exists,name} as JSON",
      })
      .check((a) => {
        if (!a.path && !a.name) throw new Error("Provide --path or --name");
        return true;
      }),
  handler: (argv) => {
    runProjectExist({
      path: argv.path,
      name: argv.name,
      printName: argv.printName,
      json: argv.json,
    });
  },
};

export const projectCommand: CommandModule = {
  command: "project",
  describe: "Query a single registered project (exist)",
  builder: (y) => y.command(existCommand).demandCommand(1),
  handler: () => {},
};
