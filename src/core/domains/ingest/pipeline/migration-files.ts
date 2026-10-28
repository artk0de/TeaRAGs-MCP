import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * The code scanner's exclusion verdict (`FileScanner#exclusionOf`), loaded for
 * the discovery root (`FileScanner#loadIgnorePatterns` already ran). Migration
 * discovery prunes with it so the migration corpus never reaches a directory
 * the code index leaves out — `.claude/worktrees/`, `vendor/`, marker-pruned
 * dirs (bd tea-rags-mcp-vx81b). Declared here, not imported, because the
 * scanner already depends on this module for `isMigrationPath`.
 */
export interface MigrationDirectoryExclusion {
  exclusionOf: (relativePath: string, isDirectory: boolean) => { ignoreRule?: string } | undefined;
}

export function migrationCollectionName(codeCollection: string): string {
  return `${codeCollection}_migrations`;
}

export function isMigrationPath(filePath: string): boolean {
  return /(?:^|\/)db\/migrate\/.+\.rb$/.test(filePath.split(sep).join("/"));
}

/**
 * Every `db/migrate/**.rb` under `root`, pruning each directory the code
 * scanner excludes. A `db` directory itself is entered regardless of the
 * ignore rules: projects ignore `db/` to keep migrations out of the CODE index,
 * which is exactly why they belong to this separate corpus.
 */
export async function discoverMigrationFiles(root: string, scanner: MigrationDirectoryExclusion): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string, insideDb: boolean): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (directory === root && err.code === "ENOENT") return [];
      throw err;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const enterDb = insideDb || entry.name === "db";
        if (enterDb || !scanner.exclusionOf(relative(root, path), true)) await walk(path, enterDb);
      } else if (entry.isFile() && isMigrationPath(relative(root, path))) {
        files.push(path);
      }
    }
  }
  await walk(root, false);
  return files.sort();
}
