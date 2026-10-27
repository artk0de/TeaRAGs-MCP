import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hookContext, renderDinopowersSkills, ROUTING_HOOKS, wrapperNames } from "./harness/dinopowers.js";
import {
  DINOPOWERS_NAME,
  DINOPOWERS_SRC,
  formatPackage,
  formatRootFile,
  HARNESS_PACKAGES,
  internalDescription,
  json,
  linkedPluginFiles,
  PLUGIN_NAME,
  PLUGIN_SRC,
  readManifest,
  readSkills,
  selectSkills,
  SHARED_HOOK_SCRIPTS,
  TURN_ROUTING_SOURCE,
  walk,
  writePackage,
  writeRootFile,
} from "./harness/package.js";
import {
  extractInjectionBlock,
  parseFrontmatter,
  toHarnessSkill,
  toHarnessText,
  type HarnessDialect,
  type SkillOptions,
} from "./harness/transform.js";

/** Package root, relative to the repository root. */
export const CURSOR_HARNESS_DIR = "harness/cursor";
/** Root marketplace manifest: the repository is a Cursor marketplace [facts §B: \`{name, owner, plugins[{name, source}]}\`]. */
export const CURSOR_MARKETPLACE_PATH = ".cursor-plugin/marketplace.json";
/**
 * Cap on the generated always-on core rule, frontmatter included. The limit is
 * ours — Cursor documents none: core cap 9,200 + ~150 chars of wrapper + margin.
 */
// owner decision 2026-10-28, 9400
export const CORE_RULE_MAX_CHARS = 9_400;

const CORE_RULE = "tea-rags-core";
const CORE_DESCRIPTION =
  "tea-rags core rules: code search, navigation and project data through the tea-rags MCP tools and resources.";

/** Cursor expands it in plugin hook commands and MCP server entries. */
const PLUGIN_ROOT_VAR = `\${CURSOR_PLUGIN_ROOT}`;

const CURSOR_DIALECT: HarnessDialect = {
  skillMention: (name) => `/${name}`,
  pluginRootVar: PLUGIN_ROOT_VAR,
  projectDirVar: "$PWD",
  readResourceTool: "FetchMcpResource",
  listResourcesTool: "ListMcpResources",
  codeSearchTool: "Grep tool",
  codeReadTool: "Read tool",
};

/**
 * Cursor's model-side resource read is undocumented and reported partly disabled,
 * so every text naming a `tea-rags://` URI also names the CLI mirror.
 */
const RESOURCE_FALLBACK =
  '> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no resource tool, or the read fails), run `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.';

/**
 * Plugin folders Cursor gives a meaning to: `rules/` is scanned for rule files,
 * so linked reference Markdown that lives under it in the plugin moves out.
 */
const RELOCATED: [from: string, to: string][] = [["rules/references/", "references/"]];

function relocate(path: string): string {
  const hit = RELOCATED.find(([from]) => path.startsWith(from));
  return hit ? hit[1] + path.slice(hit[0].length) : path;
}

function relocateLinks(md: string): string {
  return RELOCATED.reduce(
    (text, [from, to]) => text.replace(new RegExp(`((?:\\.\\./)+)${from.replace(/\//g, "\\/")}`, "g"), `$1${to}`),
    md,
  );
}

/** Puts the resource fallback under the first `# ` heading (or atop the body) when the text names a URI. */
function withResourceFallback(md: string): string {
  if (!md.includes("tea-rags://")) return md;
  const heading = /^# .*$/m.exec(md);
  if (!heading) return `${RESOURCE_FALLBACK}\n\n${md}`;
  const at = heading.index + heading[0].length;
  return `${md.slice(0, at)}\n\n${RESOURCE_FALLBACK}${md.slice(at)}`;
}

function cursorText(md: string, skillNames: ReadonlySet<string>, wrappers = false): string {
  return withResourceFallback(relocateLinks(toHarnessText(md, CURSOR_DIALECT, skillNames, wrappers)));
}

/** A Claude Code SKILL.md in Cursor's dialect: `/skill` mentions, Cursor variables, resource fallback. */
export function toCursorSkill(md: string, options: SkillOptions): string {
  const skill = toHarnessSkill(md, CURSOR_DIALECT, options);
  const { body } = parseFrontmatter(skill);
  return skill.slice(0, skill.length - body.length) + withResourceFallback(relocateLinks(body));
}

/** Cursor refuses a hook's `additional_context` longer than this (cursor-agent `HookAdditionalContextTooLargeError`). */
export const HOOK_CONTEXT_MAX_CHARS = 10_000;

/** Runs a plugin hook script: hooks start in the plugin directory, so the script path is quoted and run by bash. */
const hookCommand = (script: string): string => `bash "${PLUGIN_ROOT_VAR}/scripts/${script}"`;

/**
 * Bash lines setting `BIN` to the `tea-rags` binary, or empty: `TEA_RAGS_BIN`, `PATH`, then the usual
 * global bin folders — Cursor's hook PATH may miss the npm global bin (`LIVE-TEST.md`).
 */
const TEA_RAGS_BIN_LOOKUP = `BIN="\${TEA_RAGS_BIN:-}"
if [ -z "$BIN" ]; then
  BIN=$(command -v tea-rags 2>/dev/null)
fi
if [ -z "$BIN" ]; then
  for CANDIDATE in "$HOME/.npm-global/bin/tea-rags" /opt/homebrew/bin/tea-rags /usr/local/bin/tea-rags; do
    if [ -x "$CANDIDATE" ]; then
      BIN="$CANDIDATE"
      break
    fi
  done
fi`;

/** Bash lines setting `PROJECT` to the workspace: `CURSOR_PROJECT_DIR`, else stdin `workspace_roots[0]` (needs `INPUT`). */
const PROJECT_DIR_LOOKUP = `PROJECT="\${CURSOR_PROJECT_DIR:-}"
if [ -z "$PROJECT" ]; then
  PROJECT=$(printf '%s' "$INPUT" | jq -r '.workspace_roots[0] // empty' 2>/dev/null)
fi`;

const SESSION_START_SCRIPT = `#!/bin/bash
# Cursor sessionStart hook — generated by scripts/gen-harness-cursor.ts, do not edit.
# Answers with \`tea-rags prime <project>\` as additional_context, followed by the stale-build
# warning of check-build-fresh.sh (the Claude plugin's SessionStart script, shipped verbatim).
# sessionStart is fire-and-forget: a missing digest is covered by the core rule.
# Plugin hooks run in the plugin directory: the project comes from CURSOR_PROJECT_DIR or stdin, never $PWD.

INPUT=$(cat)
${PROJECT_DIR_LOOKUP}
if [ -z "$PROJECT" ]; then
  echo '{}'
  exit 0
fi
${TEA_RAGS_BIN_LOOKUP}
DIGEST=""
WARNING=""
if [ -n "$BIN" ]; then
  DIGEST=$("$BIN" prime "$PROJECT" 2>/dev/null)
  SCRIPTS=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
  WARNING=$(PATH="$(dirname "$BIN"):$PATH" bash "$SCRIPTS/check-build-fresh.sh" 2>/dev/null)
fi
CONTEXT="$DIGEST"
if [ -n "$WARNING" ]; then
  CONTEXT="\${CONTEXT:+$CONTEXT

}$WARNING"
fi
if [ -z "$CONTEXT" ]; then
  echo '{}'
  exit 0
fi
jq -n --arg context "$CONTEXT" '{ additional_context: $context[0:${HOOK_CONTEXT_MAX_CHARS}] }' 2>/dev/null || echo '{}'
exit 0
`;

/**
 * beforeReadFile + beforeShellExecution hook (bd tea-rags-mcp-xkbkv): the Cursor form of the Claude
 * plugin's `deny-indexed-read.sh`. Membership and operand parsing belong to
 * `tea-rags project indexed --json`; the script maps Cursor's stdin (`file_path`; `command` + `cwd`)
 * onto it. Both are permission hooks, and Cursor blocks one whose stdout is not schema-valid JSON, so
 * failing open prints `{"permission":"allow"}` — never nothing. cursor-agent hands the model
 * `user_message` ("File read was blocked by a hook: <user_message>"), the IDE `agent_message`: both
 * carry the reason. A read with attachments is the user's own context, never denied.
 */
const DENY_INDEXED_READ_SCRIPT = String.raw`#!/bin/bash
# Cursor beforeReadFile / beforeShellExecution hook — generated by scripts/gen-harness-cursor.ts, do not edit.
# Denies reading a file the tea-rags index serves (the Read tool, or a shell
# cat / sed / head / tail / less / more, compounds included) and points at
# find_symbol instead. One call of 'tea-rags project indexed --json' decides.
# Fails open on everything: no jq, no CLI, a CLI error, unparsable input or output.

ALLOW='{"permission":"allow"}'
command -v jq >/dev/null 2>&1 || { echo "$ALLOW"; exit 0; }
INPUT=$(cat)
field() { printf '%s' "$INPUT" | jq -r "$1 // empty" 2>/dev/null; }
allow() { echo "$ALLOW"; exit 0; }
${TEA_RAGS_BIN_LOOKUP}
[ -n "$BIN" ] || allow

case "$(field '.hook_event_name')" in
  beforeReadFile)
    ATTACHED=$(field '.attachments | length')
    [ -z "$ATTACHED" ] || [ "$ATTACHED" = 0 ] || allow
    FILE=$(field '.file_path')
    [ -n "$FILE" ] || allow
    # Media and archives are never code; skip the CLI call for them.
    case "$(printf '%s' "$FILE" | awk -F. '{ print tolower($NF) }')" in
      png | jpg | jpeg | gif | webp | bmp | ico | svg | pdf | zip | gz | tgz | tar | woff | woff2 | ttf | mp4 | mov | wav | mp3) allow ;;
    esac
    case "$FILE" in
      /*) ;;
      *)
        BASE="$CURSOR_PROJECT_DIR"
        [ -n "$BASE" ] || BASE=$(field '.workspace_roots[0]')
        [ -n "$BASE" ] || allow
        FILE="$BASE/$FILE"
        ;;
    esac
    ANSWER=$("$BIN" project indexed --path "$FILE" --json 2>/dev/null) || allow
    READS="File reads"
    ;;
  beforeShellExecution)
    COMMAND=$(field '.command')
    printf '%s' "$COMMAND" | grep -qE '(^|[;&|(${"`"}[:space:]])(cat|sed|head|tail|less|more)([[:space:]]|$)' || allow
    CWD=$(field '.cwd')
    [ -n "$CWD" ] || CWD="$CURSOR_PROJECT_DIR"
    [ -n "$CWD" ] || CWD=$(field '.workspace_roots[0]')
    [ -n "$CWD" ] || allow
    ANSWER=$("$BIN" project indexed --command "$COMMAND" --cwd "$CWD" --json 2>/dev/null) || allow
    READS="Shell file reads"
    ;;
  *) allow ;;
esac

REL=$(printf '%s' "$ANSWER" | jq -r 'select(.indexed == true) | .relativePath // empty' 2>/dev/null)
[ -n "$REL" ] || allow
SUBJECT="$FILE"
[ -n "$SUBJECT" ] || SUBJECT="$REL"

REASON="$SUBJECT is indexed — read it with find_symbol(relativePath: \"$REL\") (outline; small file = full text), or find_symbol(symbols: [<the method ids you need>]) when ids are known. $READS are for files outside the index."
jq -n --arg reason "$REASON" '{ permission: "deny", user_message: $reason, agent_message: $reason }' 2>/dev/null || allow
exit 0
`;

/**
 * subagentStart hook: the Cursor form of the Claude plugin's `enforce-tearags-search.sh`. Cursor
 * documents only `permission` / `user_message` for this event, but cursor-agent 2026.10.22 forwards
 * the hook's `additional_context` with the subagentStart response (bundle `index.js`), so the block
 * rides there. A permission hook: stdout is always a schema-valid allow, the subagent never blocked.
 */
const SUBAGENT_START_SCRIPT = `#!/bin/bash
# Cursor subagentStart hook — generated by scripts/gen-harness-cursor.ts, do not edit.
# Answers {"permission":"allow","additional_context":<scripts/subagent-block.txt>}, prefixed with the
# repository's project alias when tea-rags resolves one. Never blocks the subagent.

INPUT=$(cat)
SCRIPTS=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
BLOCK=$(cat "$SCRIPTS/subagent-block.txt" 2>/dev/null)
if [ -z "$BLOCK" ]; then
  echo '{"permission":"allow"}'
  exit 0
fi
${PROJECT_DIR_LOOKUP}
${TEA_RAGS_BIN_LOOKUP}
ALIAS=""
if [ -n "$BIN" ] && [ -n "$PROJECT" ]; then
  ALIAS=$("$BIN" project exist --path "$PROJECT" --repository --print-name 2>/dev/null | head -n 1)
fi
if [ -n "$ALIAS" ]; then
  BLOCK="tea-rags project alias for this repository: \\\`\${ALIAS}\\\` — pass project=\\"\${ALIAS}\\" together with path=<your working directory> on every tea-rags call.
\${BLOCK}"
fi
jq -n --arg context "$BLOCK" '{ permission: "allow", additional_context: $context[0:${HOOK_CONTEXT_MAX_CHARS}] }' 2>/dev/null || echo '{"permission":"allow"}'
exit 0
`;

/**
 * afterShellExecution hook: maps Cursor's `{command, output}` onto the Claude PostToolUse(Bash) shape and
 * runs the Claude plugin's `cleanup-worktree-clone.sh`, shipped verbatim, with the resolved `tea-rags`
 * on PATH. Cursor documents no output for this event; the hook prints `{}`.
 */
const AFTER_SHELL_SCRIPT = `#!/bin/bash
# Cursor afterShellExecution hook — generated by scripts/gen-harness-cursor.ts, do not edit.
# Drops tea-rags worktree clones whose worktree is gone after a git worktree teardown, through
# cleanup-worktree-clone.sh (the Claude plugin's PostToolUse(Bash) script). Never fails the tool.

INPUT=$(cat)
${TEA_RAGS_BIN_LOOKUP}
if [ -n "$BIN" ] && command -v jq >/dev/null 2>&1; then
  SCRIPTS=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
  printf '%s' "$INPUT" \\
    | jq -c '{ tool_name: "Bash", tool_input: { command: (.command // "") }, tool_response: { stdout: (.output // "") } }' 2>/dev/null \\
    | PATH="$(dirname "$BIN"):$PATH" bash "$SCRIPTS/cleanup-worktree-clone.sh" >/dev/null 2>&1
fi
echo '{}'
exit 0
`;

/** Claude plugin scripts the Cursor hooks run, shipped verbatim from `plugins/tea-rags/scripts/`. */
const CLAUDE_HOOK_SCRIPTS = ["check-build-fresh.sh", "cleanup-worktree-clone.sh"] as const;

/** Cursor sessionStart hook answering with the dinopowers main-session routing table. */
const DINOPOWERS_SESSION_START_SCRIPT = `#!/bin/bash
# Cursor sessionStart hook — generated by scripts/gen-harness-cursor.ts, do not edit.
# Answers with the dinopowers wrapper routing table (scripts/${ROUTING_HOOKS.mainSession.text})
# as additional_context. Subagents get no table from this hook: it answers sessionStart only (cursor-agent 2026.10.22 maps subagentStart output to additionalContext, harness-facts §B.3).

cat > /dev/null
ROOT="\${CURSOR_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
CONTEXT=$(cat "$ROOT/scripts/${ROUTING_HOOKS.mainSession.text}" 2>/dev/null)
if [ -z "$CONTEXT" ]; then
  echo '{}'
  exit 0
fi
jq -n --arg context "$CONTEXT" '{ additional_context: $context[0:${HOOK_CONTEXT_MAX_CHARS}] }' 2>/dev/null || echo '{}'
exit 0
`;

/** `dinopowers/**`: wrappers as `/dino-<s>`, the main-session routing table at sessionStart. */
function renderCursorDinopowers(root: string, teaRagsSkills: ReadonlySet<string>): Map<string, string> {
  const manifest = readManifest(join(root, DINOPOWERS_SRC));
  const mentionable = new Set([...teaRagsSkills, ...wrapperNames(root)]);
  const { files } = renderDinopowersSkills(
    root,
    { skill: toCursorSkill, text: (md, names) => cursorText(md, names, true), place: relocate },
    mentionable,
  );
  const { script, variable, text } = ROUTING_HOOKS.mainSession;
  const context = toHarnessText(hookContext(root, script, variable), CURSOR_DIALECT, mentionable, true);
  files.set(`${DINOPOWERS_NAME}/scripts/${text}`, `${context}\n`);
  files.set(`${DINOPOWERS_NAME}/scripts/session-start.sh`, DINOPOWERS_SESSION_START_SCRIPT);
  files.set(
    `${DINOPOWERS_NAME}/.cursor-plugin/plugin.json`,
    json({
      name: DINOPOWERS_NAME,
      version: manifest.version,
      description: manifest.description,
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.keywords ? { keywords: manifest.keywords } : {}),
    }),
  );
  files.set(
    `${DINOPOWERS_NAME}/hooks/hooks.json`,
    json({
      version: 1,
      hooks: { sessionStart: [{ command: hookCommand("session-start.sh"), timeout: 10 }] },
    }),
  );
  return files;
}

function readme(version: string, skills: string[], hasCore: boolean): string {
  const core = hasCore
    ? "- `tea-rags/rules/tea-rags-core.mdc` — `rules/core.md` as an `alwaysApply: true` rule, with the terminal fallback for resource reads."
    : "- `rules/core.md` does not exist yet: no `tea-rags/rules/tea-rags-core.mdc` is emitted. It appears on the first `npm run gen:harness-cursor` after it lands.";
  return `# tea-rags for Cursor

GENERATED by \`scripts/gen-harness-cursor.ts\` from \`plugins/tea-rags/\` — do not edit.
Plugin version ${version}. Live-tested only up to the Cursor login: see \`LIVE-TEST.md\`; run the open
\`MANUAL-TEST.md\` checks before relying on it.

Rendered from \`plugins/tea-rags/skills/**\`, \`plugins/tea-rags/rules/core.md\` and the plugin version.
Try an edit locally with \`npm run gen:plugins\`; the release regenerates this package and commits it.

## Layout

- \`tea-rags/.cursor-plugin/plugin.json\` — manifest; components come from the default folders.
- \`tea-rags/mcp.json\` — stdio server \`tea-rags server\` (explicit \`type\`, required for plugins).
- \`tea-rags/hooks/hooks.json\` — \`sessionStart\` → \`bash "\${CURSOR_PLUGIN_ROOT}/scripts/session-start.sh"\`, which
  prints \`{ "additional_context": "<tea-rags prime output>" }\` (capped at Cursor's ${HOOK_CONTEXT_MAX_CHARS} chars) for
  \`CURSOR_PROJECT_DIR\` (else stdin \`workspace_roots[0]\`; plugin hooks run in the plugin directory, so never
  \`$PWD\`), followed by the stale-build warning of \`scripts/check-build-fresh.sh\`. \`tea-rags\` comes from
  \`TEA_RAGS_BIN\`, \`PATH\` or the usual global bin folders. The same file wires the Claude plugin's other hooks:
  \`subagentStart\` → \`scripts/subagent-start.sh\` (\`{"permission":"allow","additional_context":<search block + alias>}\`;
  the field is undocumented for this event, cursor-agent forwards it), \`beforeReadFile\` and \`beforeShellExecution\` →
  \`scripts/deny-indexed-read.sh\` (\`permission: "deny"\` + \`user_message\` / \`agent_message\` naming \`find_symbol\` when
  \`tea-rags project indexed\` says the file is indexed; \`{"permission":"allow"}\` on every other outcome — Cursor blocks
  a permission hook with invalid stdout), \`afterShellExecution\` → \`scripts/after-shell-execution.sh\` (worktree-clone
  cleanup through the Claude \`cleanup-worktree-clone.sh\`, shipped verbatim). No \`preCompact\` hook: observational only.
  Shared with Claude and Codex, shipped verbatim (\`--harness cursor\`): \`preToolUse\` (\`Shell|Read|Grep\`) →
  \`scripts/search-drift.sh\` — \`permission: "deny"\` once after 3 text searches, 3 indexed-code reads or 4 mixed with no
  tea-rags call (one deny per 120 s), reset by \`afterMCPExecution\` from server \`tea-rags\`; \`beforeSubmitPrompt\` +
  \`postToolUse\` → \`scripts/turn-routing.sh\` — the prompt arms the turn (\`{"continue":true}\`), its first tool result
  carries \`scripts/turn-routing.txt\` as \`additional_context\` (beforeSubmitPrompt has no context channel; a turn with no
  tool call gets no re-inject).
- \`tea-rags/skills/\` — the tea-rags skills (${skills.length}): every user-invocable one plus each internal skill a
  shipped skill names.
- \`dinopowers/\` — the wrappers as \`skills/dino-<s>/\` (Claude Code \`dinopowers:<s>\`; \`superpowers:<s>\` → \`/<s>\`),
  \`CHAINING.md\` / \`FRESHNESS.md\` they link to, and a \`sessionStart\` hook (\`scripts/session-start.sh\`) answering with
  the main-session routing table (\`scripts/main-session-routing.txt\`). No MCP server: the wrappers call tea-rags'.
  superpowers is not bundled — install it per https://github.com/obra/superpowers; a wrapper without it stops and asks.
- \`tea-rags/repair/\`, \`tea-rags/references/\` — plugin files the skills link to. \`rules/references/\` moves to
  \`references/\` (links rewritten) so \`rules/\` holds rule files only.
${core}

## Install (UNVERIFIED — second-hand, facts §B.1)

Marketplace: the repository root carries \`${CURSOR_MARKETPLACE_PATH}\` (\`source\` = \`./${CURSOR_HARNESS_DIR}/<plugin>\`);
add the repository as a marketplace where your Cursor build supports it (UNVERIFIED, see \`MANUAL-TEST.md\`). Local copy:

\`\`\`bash
mkdir -p ~/.cursor/plugins/local
cp -R <repo>/harness/cursor/tea-rags ~/.cursor/plugins/local/tea-rags   # copy, do not symlink out of the folder
\`\`\`

Then Reload Window. Enterprise workspaces need "Allow Local Plugin Imports". Development build instead of the
global binary: in the installed \`mcp.json\` set \`"command": "node", "args": ["<repo>/build/index.js"]\`. The hook
and the terminal resource fallback still call \`tea-rags\` — point \`TEA_RAGS_BIN\` / \`PATH\` at a build that has
the \`resource\` command.

Seen in cursor-agent ${CURSOR_AGENT_VERSION} (\`LIVE-TEST.md\`): it reads \`~/.cursor/plugins/local/\`, takes
\`--plugin-dir <path>\` per plugin, and adds marketplaces only from a git URL indexed for a logged-in account
(\`agent plugin marketplace add <gitUrl> [--git-ref]\`) — a local checkout cannot be added as a marketplace.

## Transform rules

Codex rules (\`scripts/harness/transform.ts\`) with Cursor's dialect: skills mentioned as \`/<skill>\`;
\`ReadMcpResourceTool\` / \`ListMcpResourcesTool\` → \`FetchMcpResource\` / \`ListMcpResources\` (observed names);
\`CLAUDE_PLUGIN_ROOT\` → \`CURSOR_PLUGIN_ROOT\`, \`CLAUDE_PROJECT_DIR\` → \`PWD\`; frontmatter → \`name\` (= folder) +
\`description\`. Every file naming a \`tea-rags://\` URI gets the terminal fallback
\`tea-rags resource "<uri>" --path "$PWD"\` under its title.

## Facts (docs only; full list with sources: \`docs/superpowers/specs/2026-10-23-harness-facts.md\` §B)

- Manifest \`.cursor-plugin/plugin.json\`: required \`name\`; optional description, version, author, homepage,
  repository, license, keywords, logo, rules, agents, skills, commands, hooks, mcpServers, variables. Default folders
  \`skills/<n>/SKILL.md\`, \`rules/*.{md,mdc,markdown}\`, \`hooks/hooks.json\`, root \`mcp.json\`; a manifest path replaces
  discovery for that component [D:cursor.com/docs/reference/plugins].
- Rules \`.mdc\`: \`description\`, \`globs\`, \`alwaysApply\` (true = every session); keep under 500 lines
  [D:cursor.com/docs/context/rules].
- hooks.json \`{"version":1,"hooks":{"<event>":[{command, timeout, …}]}}\`; sessionStart may return \`env\` and
  \`additional_context\`, fire-and-forget; subagentStart returns only \`permission\` / \`user_message\` per docs, yet
  cursor-agent forwards its \`additional_context\` [S:bundle]; preCompact is observational; beforeReadFile /
  beforeShellExecution deny with \`permission: "deny"\`, the model sees "<Action> was blocked by a hook: <user_message>"
  [D:cursor.com/docs/hooks; S:bundle].
- Plugin MCP servers must declare \`type\`; \`\${CURSOR_PLUGIN_ROOT}\` expands in command, args, env, cwd [D:reference/plugins].
- Skills: \`name\` lowercase-hyphen, equal to the folder; \`description\` required; invoked by description or
  \`/skill-name\` [D:cursor.com/docs/context/skills].
- Model-side MCP resource tools are not documented; forum reports \`ListMcpResources\` / \`FetchMcpResource\` and staff
  said resources were partly disabled — OBSERVED ONLY, hence the terminal fallback [F:forum.cursor.com].
- \`cursor-agent -p --output-format json|stream-json\`, \`--force\`, \`--approve-mcps\`, \`--workspace\`; whether plugin
  hooks fire in \`-p\` mode is UNVERIFIED [D:cursor.com/docs/cli/reference/parameters].
`;
}

const MANUAL_TEST = `# Cursor manual test — tea-rags harness

GENERATED by \`scripts/gen-harness-cursor.ts\` — do not edit. Cursor was not available where the package was built;
these checks are the hand-over. Record pass/fail, the tool calls seen and any deviation next to each check.

## Setup

1. \`npm run build\`, then install the package per \`README.md\` (copy to \`~/.cursor/plugins/local/tea-rags\`,
   Reload Window). Point the installed \`mcp.json\` at \`<repo>/build/index.js\` for a development build.
   Marketplace route (UNVERIFIED — format from docs, never loaded): add the repository as a marketplace; Cursor
   must read \`${CURSOR_MARKETPLACE_PATH}\` at the repository root and resolve \`./${CURSOR_HARNESS_DIR}/tea-rags\`.
   Record whether it lists \`tea-rags\` and installs the same files as the copy.
2. Open the tea-rags repository (indexed alias \`tea-rags\`) as the workspace.
3. CLI runs: \`CURSOR_API_KEY=… cursor-agent -p --output-format stream-json --force --approve-mcps --workspace <repo> "<prompt>"\`;
   inspect \`tool_call\` events (MCP calls observed as \`mcpToolCall\`, resource reads as \`readMcpResourceToolCall\` —
   unconfirmed shapes, note what you see).

## Checks (IDE agent chat, then the same prompt through \`cursor-agent -p\`)

1. **Plugin loads** — Settings → Plugins lists \`tea-rags\`; the MCP server \`tea-rags\` is connected; skills
   (\`/explore\`, \`/bug-hunt\`, …) appear in the slash menu; hooks show \`sessionStart\`.
2. **Resource read without \`@\`** — "Quote the first heading of tea-rags://guide/navigation." Expect a
   \`FetchMcpResource\` call, or — when the resource tool is missing or fails — a terminal
   \`tea-rags resource "tea-rags://guide/navigation" --path "$PWD"\`. Either way the answer quotes a \`# \` heading.
   Record which route was taken.
3. **Navigation** — "Where is registerAllResources defined? Show its body." Expect \`find_symbol\`; no terminal
   \`cat\` / \`grep\` / \`rg\` over \`src/\`.
4. **Project metrics** — "What are this project's ruby/typescript signal thresholds?" Expect a read of
   \`tea-rags://project/tea-rags/metrics…\` (resource or terminal fallback).
5. **sessionStart digest** — in a fresh chat ask "What does the tea-rags digest in your context say about this
   project?" before any tool call. Expect digest facts (alias, index state). If absent, check
   \`scripts/session-start.sh\` by hand: \`echo '{"workspace_roots":["<repo>"]}' | ~/.cursor/plugins/local/tea-rags/scripts/session-start.sh\`
   must print \`{"additional_context": …}\`. Record whether \`-p\` mode fires the hook at all.
6. **Skill trigger** — "Use the bug-hunt skill: why does prime print an empty digest when Qdrant is down?" Expect
   the skill to load (\`/bug-hunt\`) and a resource read (or its terminal fallback) to happen.
7. **\`alwaysApply\` rule reaches a subagent** (only once \`rules/tea-rags-core.mdc\` ships) — ask the agent to
   delegate "find every caller of registerAllResources" to a subagent. Expect the subagent to use
   \`hybrid_search\` / \`get_callers\`, not grep. If it greps, ask the subagent whether its context names the tea-rags
   project alias: the \`subagentStart\` hook sends the search block as \`additional_context\`, a field Cursor documents
   only for sessionStart — record whether it arrived.
9. **Indexed-read deny** — "Read src/cli/index.ts with your file read tool, then with \`sed -n 1,40p\`." Expect both
   reads blocked with a reason naming \`find_symbol(relativePath: "src/cli/index.ts")\`, then a \`find_symbol\` call.
8. **dinopowers routing** — with \`dinopowers\` installed, ask "brainstorm a cache for get_index_status" in a fresh
   chat. Expect \`/dino-brainstorming\` to load and chain into \`/brainstorming\` (superpowers); without superpowers
   installed, expect the wrapper to stop and ask for the install. Record whether \`/brainstorming\` and
   \`/dino-brainstorming\` both appear in the slash menu.
`;

/** Versions the live test of \`LIVE-TEST.md\` ran with. */
const CURSOR_APP_VERSION = "3.27.12";
const CURSOR_AGENT_VERSION = "2026.10.22-27dcf5f";

/** Record of the live run (bead tea-rags-mcp-9lynw.28); \`harness/cursor/\` is regenerated whole, so it lives here. */
const LIVE_TEST = `# Cursor live test — tea-rags harness

GENERATED by \`scripts/gen-harness-cursor.ts\` — do not edit; update the \`LIVE_TEST\` record there. Run 2026-10-23
against \`MANUAL-TEST.md\`, repository \`tea-rags-mcp\` (alias \`tea-rags\`).

## Environment

- Cursor ${CURSOR_APP_VERSION} (\`brew install --cask cursor\`), cursor-agent \`${CURSOR_AGENT_VERSION}\`
  (\`curl https://cursor.com/install -fsS | bash\` → \`~/.local/bin/agent\`, \`cursor-agent\`).
- Install: \`harness/cursor/tea-rags\` and \`harness/cursor/dinopowers\` copied to \`~/.cursor/plugins/local/\`; the
  installed \`mcp.json\` runs \`node <worktree>/build/index.js\`. superpowers not installed.
- Model: none. cursor-agent is not logged in (\`agent status\` → "Not logged in"; no \`CURSOR_API_KEY\`), and every
  agent run, \`plugin marketplace add|list\` included, needs a Cursor account. z.ai (GLM over the OpenAI protocol,
  base URL \`https://api.z.ai/api/coding/paas/v4\`, model name uppercase) is an IDE setting only: Settings →
  Models → Add Custom Model; cursor-agent has no custom base URL (\`--endpoint\` is Cursor's own API). No z.ai key
  in the environment.

## Checks

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Plugin loads | static only | cursor-agent bundle reads \`~/.cursor/plugins/local\`, \`hooks.json\`, \`mcp.json\`, \`SKILL.md\`, \`.mdc\`; \`agent mcp list\` (with or without \`--plugin-dir\`) lists only \`.cursor/mcp.json\` / \`~/.cursor/mcp.json\` servers |
| 2 | Resource read | fallback pass | \`node build/cli/index.js resource tea-rags://guide/navigation\` → \`# Navigation — after any search\`; tool names \`FetchMcpResource\` / \`ListMcpResources\` and events \`mcpToolCall\` / \`readMcpResourceToolCall\` exist in the CLI bundle; agent run blocked by login |
| 3 | Navigation | blocked | needs an agent run |
| 4 | Project metrics | fallback pass | \`resource tea-rags://project/tea-rags/metrics\` → \`## Signal thresholds — typescript\` |
| 5 | sessionStart digest | fixed, script pass | see Fixes; digest 6500 chars in ~8 s (timeout 15 s), dinopowers table 1294 chars |
| 6 | Skill trigger | blocked | needs an agent run |
| 7 | Rule reaches subagent | blocked | needs an agent run |
| 8 | dinopowers routing | blocked | needs an agent run; superpowers absent, so the wrapper must stop and ask |

## Fixes

- The hook took the project from \`$PWD\`; Cursor runs plugin hooks in the plugin directory and passes the workspace as
  \`CURSOR_PROJECT_DIR\` (set from \`workspacePath\` in the CLI bundle). The script now reads \`CURSOR_PROJECT_DIR\`,
  then stdin \`workspace_roots[0]\`, else answers \`{}\`.
- Hook commands run as \`bash "\${CURSOR_PLUGIN_ROOT}/scripts/session-start.sh"\`; \`tea-rags\` is resolved through
  \`TEA_RAGS_BIN\`, \`PATH\`, then the usual global bin folders.
- cursor-agent rejects \`additional_context\` over ${HOOK_CONTEXT_MAX_CHARS} chars (\`HookAdditionalContextTooLargeError\`);
  both hooks now cap it.

## Hooks run, 2026-10-27 (bead tea-rags-mcp-xkbkv)

cursor-agent \`${CURSOR_AGENT_VERSION}\`, logged in, scratch workspace with a project \`.cursor/hooks.json\` that
records every event's stdin (the global Cursor config untouched).

- Captured: project hooks fire in \`-p\` mode, run with the workspace as cwd and \`CURSOR_PROJECT_DIR\` set.
  sessionStart stdin = \`conversation_id\`, \`generation_id\`, \`model\`, \`is_background_agent\`, \`session_id\`,
  \`hook_event_name\`, \`cursor_version\`, \`workspace_roots\`, \`user_email\`, \`transcript_path\` (no \`composer_mode\`).
- Not captured: every agent turn ended "You've hit your usage limit" (Free plan; other models "unavailable on
  Free"), so no tool event fired. Tool-event stdin comes from the docs and the CLI bundle: beforeReadFile
  \`{…base, file_path, content, attachments: [], tool_use_id}\` (runs after the read, deny throws "File read was
  blocked by a hook: <user_message>"); beforeShellExecution \`{…base, command, cwd, sandbox, tool_use_id}\` (deny →
  "Command execution was blocked by a hook: <user_message>"); afterShellExecution \`{…base, command, output,
  duration, sandbox, tool_use_id}\`; subagentStart response mapped to \`{permission, userMessage, additionalContext}\`.
- By hand, generated scripts against the worktree build on this repository with that stdin: an indexed
  \`src/**\` file → deny naming \`find_symbol(relativePath: …)\` for both the read and \`sed -n\`; \`package.json\` and
  \`git status\` → allow; subagentStart → allow + 2873-char block led by the \`tea-rags\` alias; sessionStart → digest.

## Open

- An agent run proving the deny is followed by \`find_symbol\` (MANUAL-TEST check 9) and that subagentStart
  \`additional_context\` reaches the subagent (check 7): needs agent usage on the account.
- The global \`tea-rags\` (main checkout, 1.49.0) has no \`resource\` command until this branch ships, so the terminal
  fallback fails there.
- Checks 1–8 through an agent: log in (\`agent login\` or \`CURSOR_API_KEY\`), then run \`MANUAL-TEST.md\` Setup 3.
- Local marketplace: cursor-agent adds only git URLs indexed for the account; \`.cursor-plugin/marketplace.json\` is
  untested until the branch is pushed.
`;

/**
 * The whole Cursor package as `path (relative to harness/cursor) → content`,
 * Prettier-formatted like the committed files, so a regeneration leaves no diff.
 */
export async function renderCursorHarness(root: string): Promise<Map<string, string>> {
  const pluginRoot = join(root, PLUGIN_SRC);
  const manifest = readManifest(pluginRoot);
  const corePath = join(pluginRoot, "rules/core.md");
  const hasCore = existsSync(corePath);
  const selected = selectSkills(readSkills(pluginRoot));
  const skillNames = new Set(selected.map(({ skill }) => skill.name));

  const files = new Map<string, string>();
  for (const { skill, callers } of selected) {
    const description = skill.internal ? internalDescription(skill, callers, CURSOR_DIALECT.skillMention) : undefined;
    for (const file of walk(skill.dir)) {
      const rel = relative(skill.dir, file);
      const source = readFileSync(file, "utf8");
      const out =
        rel === "SKILL.md"
          ? toCursorSkill(source, { skillNames, name: skill.name, description })
          : file.endsWith(".md")
            ? cursorText(source, skillNames)
            : source;
      files.set(`${PLUGIN_NAME}/skills/${skill.name}/${rel}`, out);
    }
  }
  for (const file of linkedPluginFiles(
    pluginRoot,
    selected.flatMap(({ skill }) => walk(skill.dir)),
  )) {
    const source = readFileSync(file, "utf8");
    const out = file.endsWith(".md") ? cursorText(source, skillNames) : source;
    files.set(`${PLUGIN_NAME}/${relocate(relative(pluginRoot, file))}`, out);
  }

  if (hasCore) {
    const core = parseFrontmatter(readFileSync(corePath, "utf8")).body;
    const body = withResourceFallback(`${toHarnessText(core, CURSOR_DIALECT, skillNames).trim()}\n`);
    files.set(
      `${PLUGIN_NAME}/rules/${CORE_RULE}.mdc`,
      `---\ndescription: ${JSON.stringify(CORE_DESCRIPTION)}\nalwaysApply: true\n---\n\n${body}`,
    );
  }

  files.set(`${PLUGIN_NAME}/scripts/session-start.sh`, SESSION_START_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/subagent-start.sh`, SUBAGENT_START_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/deny-indexed-read.sh`, DENY_INDEXED_READ_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/after-shell-execution.sh`, AFTER_SHELL_SCRIPT);
  for (const script of [...CLAUDE_HOOK_SCRIPTS, ...SHARED_HOOK_SCRIPTS]) {
    files.set(`${PLUGIN_NAME}/scripts/${script}`, readFileSync(join(pluginRoot, "scripts", script), "utf8"));
  }
  const turnRouting = extractInjectionBlock(readFileSync(join(pluginRoot, TURN_ROUTING_SOURCE), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/turn-routing.txt`, `${toHarnessText(turnRouting, CURSOR_DIALECT, skillNames)}\n`);
  const block = extractInjectionBlock(readFileSync(join(pluginRoot, "rules/references/subagent-injection.md"), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/subagent-block.txt`, `${toHarnessText(block, CURSOR_DIALECT, skillNames)}\n`);
  files.set(
    `${PLUGIN_NAME}/.cursor-plugin/plugin.json`,
    json({
      name: PLUGIN_NAME,
      version: manifest.version,
      description: manifest.description,
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.keywords ? { keywords: manifest.keywords } : {}),
    }),
  );
  files.set(
    `${PLUGIN_NAME}/mcp.json`,
    json({ mcpServers: { [PLUGIN_NAME]: { type: "stdio", command: "tea-rags", args: ["server"] } } }),
  );
  files.set(
    `${PLUGIN_NAME}/hooks/hooks.json`,
    json({
      version: 1,
      hooks: {
        sessionStart: [{ command: hookCommand("session-start.sh"), timeout: 60 }],
        subagentStart: [{ command: hookCommand("subagent-start.sh"), timeout: 30 }],
        beforeReadFile: [{ command: hookCommand("deny-indexed-read.sh"), timeout: 10 }],
        beforeShellExecution: [{ command: hookCommand("deny-indexed-read.sh"), timeout: 10 }],
        afterShellExecution: [{ command: hookCommand("after-shell-execution.sh"), timeout: 120 }],
        // bd tea-rags-mcp-nknkg.2: beforeSubmitPrompt has no context channel, so it arms the turn and
        // the turn's first postToolUse delivers the routing lines as additional_context.
        beforeSubmitPrompt: [{ command: `${hookCommand("turn-routing.sh")} --harness cursor`, timeout: 5 }],
        postToolUse: [{ command: `${hookCommand("turn-routing.sh")} --harness cursor`, timeout: 5 }],
        preToolUse: [
          { matcher: "Shell|Read|Grep", command: `${hookCommand("search-drift.sh")} --harness cursor`, timeout: 10 },
        ],
        afterMCPExecution: [{ command: `${hookCommand("search-drift.sh")} --harness cursor`, timeout: 5 }],
      },
    }),
  );
  files.set(
    "README.md",
    readme(
      manifest.version,
      selected.map(({ skill }) => skill.name),
      hasCore,
    ),
  );
  files.set("MANUAL-TEST.md", MANUAL_TEST);
  files.set("LIVE-TEST.md", LIVE_TEST);
  for (const [path, content] of renderCursorDinopowers(root, skillNames)) files.set(path, content);

  return formatPackage(root, CURSOR_HARNESS_DIR, files);
}

/** The root Cursor marketplace manifest: one entry per package folder under `harness/cursor/`. */
export async function renderCursorMarketplace(
  root: string,
  packages: readonly string[] = HARNESS_PACKAGES,
): Promise<string> {
  const { author } = readManifest(join(root, PLUGIN_SRC));
  return formatRootFile(
    root,
    CURSOR_MARKETPLACE_PATH,
    json({
      name: PLUGIN_NAME,
      owner: { name: author?.name ?? PLUGIN_NAME },
      plugins: packages.map((name) => ({ name, source: `./${CURSOR_HARNESS_DIR}/${name}` })),
    }),
  );
}

/** Replace `harness/cursor/` with a fresh render and rewrite the root marketplace manifest. */
export async function writeCursorHarness(root: string): Promise<number> {
  const count = writePackage(root, CURSOR_HARNESS_DIR, await renderCursorHarness(root));
  writeRootFile(root, CURSOR_MARKETPLACE_PATH, await renderCursorMarketplace(root));
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const count = await writeCursorHarness(root);
  console.log(`✓ ${CURSOR_HARNESS_DIR}: ${count} files regenerated from ${PLUGIN_SRC}, ${DINOPOWERS_SRC}.`);
}
