import { homedir } from "node:os";
import { join } from "node:path";

import { CollectionRegistry } from "../core/infra/registry/collection-registry.js";

/**
 * Subcommands of `projects` where `--name` refers to an EXISTING alias
 * (completion welcome). `register` is excluded because there the name is a
 * brand-new value the user is inventing.
 */
const NAME_FLAG_EXISTS_SUBCOMMANDS = new Set(["unregister", "info"]);

/**
 * Return the list of project alias names from the local registry. Empty
 * names (auto-recovered entries) are filtered out. Errors degrade silently
 * to `[]` so completion never crashes the shell.
 */
export function listProjectNames(): string[] {
  try {
    const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
    return new CollectionRegistry(dataDir)
      .list()
      .map((e) => e.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

/**
 * Inspect the partially-parsed argv to decide whether we should complete a
 * project alias at the current cursor. Returns the list of suggestions, or
 * `null` when no project-alias completion is needed (caller should fall back
 * to yargs defaults).
 *
 * Triggers when the previous token is one of:
 *   --project / -p           any command (tune, prime)
 *   --name / -n              ONLY under `projects unregister` / `projects info`
 *
 * `tokens` is `process.argv` minus runtime + script path (i.e. the args yargs
 * actually parses). The yargs completion fn passes `argv._` for parsed
 * positionals; we use it to identify the active subcommand.
 */
export function maybeCompleteProjectName(
  tokens: readonly string[],
  parsedPositionals: readonly string[],
): string[] | null {
  // The token immediately before the one we're completing tells us which flag
  // is taking a value. `tokens` includes the (possibly partial) current word
  // as the last entry under bash completion, so look one back from the end.
  const last = tokens[tokens.length - 2] ?? "";

  if (last === "--project" || last === "-p") {
    return listProjectNames();
  }

  if (last === "--name" || last === "-n") {
    const [topLevel, sub] = parsedPositionals;
    if (topLevel === "projects" && typeof sub === "string" && NAME_FLAG_EXISTS_SUBCOMMANDS.has(sub)) {
      return listProjectNames();
    }
  }

  return null;
}
