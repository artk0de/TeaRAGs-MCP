#!/usr/bin/env node
/**
 * Install fish-shell completion for tea-rags into ~/.config/fish/completions/.
 *
 * Why fish gets special treatment: fish auto-discovers completion files in
 * its completions directory, no rc-file edits required. Bash and zsh both
 * need a one-time `tea-rags completion >> ~/.{bash,zsh}rc` — modifying user
 * rc files from a postinstall is invasive, so those stay manual.
 *
 * Behaviour:
 *   - Skip when fish is not installed (no `fish` in PATH).
 *   - Skip when XDG/HOME directories are unreachable.
 *   - Always rewrite our own completion file (so package updates propagate
 *     fixes automatically). Detected by a header marker — if a different
 *     completion file exists at the same path that we didn't write, we leave
 *     it alone and print a hint to stderr.
 *   - Failures are non-fatal: a broken completion install must NEVER abort
 *     the package install.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Bump on every payload change so the auto-installer overwrites older
// completion files (the installer checks `startsWith(MARKER)` — a fresh
// header forces a rewrite for users on prior versions).
const MARKER = "# tea-rags-fish-completion-v2";
const OLD_MARKERS = ["# tea-rags-fish-completion-v1"];

const COMPLETION_SCRIPT = `${MARKER}
# Auto-installed by tea-rags postinstall. Overwritten on every package update.
# To remove: rm ~/.config/fish/completions/tea-rags.fish
#
# Forwards completions to yargs's --get-yargs-completions protocol.

function __tea_rags_complete
    set -lx COMP_CWORD (count (commandline -opc))
    set -lx COMP_LINE (commandline -p)
    set -lx COMP_POINT (string length -- (commandline -cp))
    tea-rags --get-yargs-completions (commandline -opc) (commandline -ct) 2>/dev/null
end

# Default: disable fish's built-in file completion so subcommand / flag
# completion (emitted by our wrapper via yargs) is not buried under filenames.
complete -c tea-rags -f -a "(__tea_rags_complete)"

# Per-option override: \`--path\` ALWAYS takes a filesystem path. Re-enable
# file completion just for this option (\`-F\` = force-files), overriding the
# \`-f\` default above.
complete -c tea-rags -l path -r -F
`;

function hasFish() {
  try {
    execSync("command -v fish", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fishCompletionsDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "fish", "completions");
  const home = homedir();
  if (!home) return null;
  return join(home, ".config", "fish", "completions");
}

function main() {
  if (!hasFish()) {
    return; // silent — most users don't have fish
  }
  const dir = fishCompletionsDir();
  if (!dir) {
    console.error("[tea-rags] fish detected but home directory unresolved; skipping completion install");
    return;
  }
  const target = join(dir, "tea-rags.fish");

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[tea-rags] fish completion: cannot create ${dir}: ${err.message}`);
    return;
  }

  if (existsSync(target)) {
    try {
      const current = readFileSync(target, "utf8");
      const isOurFile = current.startsWith(MARKER) || OLD_MARKERS.some((old) => current.startsWith(old));
      if (!isOurFile) {
        console.error(`[tea-rags] fish completion: ${target} exists and was not written by tea-rags; leaving it alone`);
        return;
      }
    } catch (err) {
      console.error(`[tea-rags] fish completion: cannot read ${target}: ${err.message}`);
      return;
    }
  }

  try {
    writeFileSync(target, COMPLETION_SCRIPT, { mode: 0o644 });
    console.error(`[tea-rags] fish completion installed at ${target}`);
  } catch (err) {
    console.error(`[tea-rags] fish completion: write failed (${err.message}); skipping`);
  }
}

main();
