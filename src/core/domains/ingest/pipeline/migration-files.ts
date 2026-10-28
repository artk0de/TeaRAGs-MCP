import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "tmp", "log"]);

export function migrationCollectionName(codeCollection: string): string {
  return `${codeCollection}_migrations`;
}

export function isMigrationPath(filePath: string): boolean {
  return /(?:^|\/)db\/migrate\/.+\.rb$/.test(filePath.split(sep).join("/"));
}

export async function discoverMigrationFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
      } else if (entry.isFile() && isMigrationPath(relative(root, path))) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return files.sort();
}
