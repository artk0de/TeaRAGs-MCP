import { homedir } from "node:os";
import { join } from "node:path";

import { CollectionRegistry } from "../core/api/public/index.js";

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
 * actually parses). yargs's completion fn passes `argv._` for parsed
 * positionals — but the first positional is the script name itself
 * (yargs convention under `--get-yargs-completions`), so we drop it.
 */
export function maybeCompleteProjectName(
  tokens: readonly string[],
  parsedPositionals: readonly string[],
): string[] | null {
  // The token immediately before the one we're completing tells us which flag
  // is taking a value. `tokens` includes the (possibly partial) current word
  // as the last entry under shell completion, so look one back from the end.
  const last = tokens[tokens.length - 2] ?? "";

  if (last === "--project" || last === "-p") {
    return listProjectNames();
  }

  // `--path` always takes a filesystem path. We don't know any paths
  // ourselves — return an empty list so the shell falls back to its own
  // file completion (fish does this automatically when the wrapper emits
  // zero lines AND the `complete -c` registration is not `-f`/--no-files).
  if (last === "--path") {
    return [];
  }

  if (last === "--name" || last === "-n") {
    // yargs places the script name as positionals[0] in completion mode.
    // Drop it so we can check the real top-level command + subcommand.
    const cleaned = parsedPositionals[0] === "tea-rags" ? parsedPositionals.slice(1) : parsedPositionals;
    const [topLevel, sub] = cleaned;
    if (topLevel === "projects" && typeof sub === "string" && NAME_FLAG_EXISTS_SUBCOMMANDS.has(sub)) {
      return listProjectNames();
    }
    // Under `projects register --name <TAB>` the user is inventing a new
    // alias — we have nothing to suggest. Emit empty so the shell shows
    // nothing (rather than yargs's default flag list which would be wrong
    // at this value position).
    if (topLevel === "projects") {
      return [];
    }
  }

  return null;
}
