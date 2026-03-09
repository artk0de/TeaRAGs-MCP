import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OLD_DIR_NAME = ".tea-rags-mcp";
const NEW_DIR_NAME = ".tea-rags";

/**
 * Migrate ~/.tea-rags-mcp → ~/.tea-rags if only old exists.
 * If both exist, leave both (user decides).
 * If neither exists, do nothing — new dir is created on demand.
 */
export function migrateHomeDir(home = homedir()): void {
  const oldPath = join(home, OLD_DIR_NAME);
  const newPath = join(home, NEW_DIR_NAME);

  if (existsSync(newPath)) return; // already migrated or fresh
  if (!existsSync(oldPath)) return; // nothing to migrate

  try {
    renameSync(oldPath, newPath);
    console.error(`[tea-rags] Migrated ${oldPath} → ${newPath}`);
  } catch (err) {
    console.error(`[tea-rags] Migration failed (${oldPath} → ${newPath}): ${(err as Error).message}`);
  }
}
