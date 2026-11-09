import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hookContext, renderDinopowersSkills, ROUTING_HOOKS, wrapperNames } from "./harness/dinopowers.js";
import {
  copyIconAssets,
  DINOPOWERS_NAME,
  DINOPOWERS_SRC,
  formatPackage,
  HARNESS_PACKAGES,
  internalDescription,
  json,
  linkedPluginFiles,
  PLUGIN_NAME,
  PLUGIN_SRC,
  PLUGINS_DIR,
  readManifest,
  readSkills,
  selectSkills,
  SETUP_NAME,
  SETUP_SRC,
  SHARED_HOOK_SCRIPTS,
  TURN_ROUTING_SOURCE,
  walk,
  writePackage,
} from "./harness/package.js";
import { renderSetupPackage } from "./harness/setup.js";
import {
  extractInjectionBlock,
  parseFrontmatter,
  toHarnessSkill,
  toHarnessText,
  type HarnessDialect,
  type SkillOptions,
} from "./harness/transform.js";

/** Package root, relative to the repository root; also the marketplace root the user pastes into ZCode. */
export const ZCODE_HARNESS_DIR = "harness/zcode";
/**
 * ZCode adds a marketplace from a local directory whose root carries
 * `.claude-plugin/marketplace.json` or a root-level `marketplace.json`
 * [S:zcode plugin-creator reference]; the root-level name keeps the generated
 * tree free of a stray `.claude-plugin/` folder. Inside the package, unlike
 * Codex/Cursor, so `harness/zcode/` is the one directory to hand over.
 */
export const ZCODE_MARKETPLACE_PATH = "marketplace.json";
/**
 * Icon URL base for the marketplace catalog. The ZCode app renderer only draws `icon` values that
 * start with `https://` (verified in the app bundle: the image validator is literally
 * `startsWith("https://")`, plus six hardcoded data-URIs for official plugins), so the catalog
 * points at the committed `assets/icons/` sources on GitHub — reachable because the repository
 * is public. A new icon shows up once its commit is pushed to `main`.
 */
const ICON_URL_BASE = "https://raw.githubusercontent.com/artk0de/TeaRAGs-MCP/main/assets/icons";

/**
 * Hook events ZCode supports — exactly seven [S:zcode-guide diagnosing-hooks;
 * verified in the zcode.cjs bundle: no `SubagentStart`, `Notification`,
 * `PreCompact`]. `SessionStart` matchers take `startup|resume|clear|compact`.
 */
export const ZCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

/** ZCode expands `${CLAUDE_PLUGIN_ROOT}` (and `${ZCODE_PLUGIN_ROOT}`) in plugin hook commands. */
const PLUGIN_ROOT_VAR = `\${CLAUDE_PLUGIN_ROOT}`;

/**
 * ZCode's dialect of the shared prose: Claude Code's protocol shape (Skill tool,
 * Read tool, `hookSpecificOutput.additionalContext`, `permissionDecision`),
 * minus the tools ZCode ships without. The built-in toolset has no Grep/Glob —
 * text search goes through the Bash tool (`rg`, else `grep`) — and no model-side
 * MCP resource tool, so `tea-rags://` URIs read through the CLI
 * (the sources already carry the "no resource tool → `tea-rags resource <uri>`"
 * fallback inline). Skills are invoked as `plugin:skill`, so a `tea-rags:<s>`
 * mention stays qualified. MCP tools keep the server name:
 * `mcp__${"<server>"}__${"<tool>"}` with only `[^a-zA-Z0-9_-]` replaced, so
 * `tea-rags` stays hyphenated [S:zcode.cjs `bN` normalization, mcp naming].
 */
const ZCODE_DIALECT: HarnessDialect = {
  skillMention: (name) => `tea-rags:${name}`,
  pluginRootVar: PLUGIN_ROOT_VAR,
  projectDirVar: "$PWD",
  readResourceTool: "`tea-rags resource <uri>` (Bash)",
  listResourcesTool: "`tea-rags resource <uri>` (Bash)",
  // ZCode's default sessions ship no Grep tool: the Bash channel is the routed
  // text search (rg preferred; `grep` always present). `-l` rides the source text.
  codeSearchTool: "Bash rg",
  foldsSearchLiteral: true,
  codeSearchToolNote: "no rg → grep; zsh: quote globs --include='*.rb'",
  codeReadTool: "Read tool",
};

/**
 * ZCode replacements on top of `toHarnessText`: no `SubagentStart` event exists,
 * so the alias/routing lines that credit it name the subagent dispatch hook
 * instead (a PreToolUse hook on the Agent tool, the only context channel ZCode
 * offers at subagent dispatch).
 */
function zcodeReplacements(md: string): string {
  return md
    .replace(/digest, SubagentStart or/, "digest, the subagent dispatch hook or")
    .replace(/\bthe SubagentStart line\b/g, "the subagent dispatch hook line")
    .replace(/\bfrom the SubagentStart line\b/g, "from the subagent dispatch hook line")
    .replace(/\bSubagentStart\b/g, "the subagent dispatch hook");
}

function zcodeText(md: string, skillNames: ReadonlySet<string>, wrappers = false): string {
  return zcodeReplacements(toHarnessText(md, ZCODE_DIALECT, skillNames, wrappers));
}

/**
 * The dinopowers package's own dialect: mentions stay BARE (`dino-<s>`, superpowers
 * `<s>`, tea-rags `<s>`). `ZCODE_DIALECT.skillMention` prefixes `tea-rags:` — right
 * for that plugin's skills, wrong here: `wrapperMentions` runs wrapper and superpowers
 * names through the same `skillMention`, which minted nonexistent `tea-rags:dino-<s>`
 * and `tea-rags:<superpowers-s>` names (caught by the full-corpus chaining eval,
 * 2026-11-09). Bare names are how ZCode lists plugin skills besides the qualified
 * form — the codex package ships the same bare semantics.
 */
const ZCODE_WRAPPER_DIALECT: HarnessDialect = { ...ZCODE_DIALECT, skillMention: (name) => name };

function zcodeWrapperText(md: string, skillNames: ReadonlySet<string>): string {
  return zcodeReplacements(toHarnessText(md, ZCODE_WRAPPER_DIALECT, skillNames, true));
}

/** A dino- wrapper SKILL.md: bare mentions inside the dinopowers package. */
export function toZcodeWrapperSkill(md: string, options: SkillOptions): string {
  const skill = toHarnessSkill(md, ZCODE_WRAPPER_DIALECT, { ...options, wrappers: true });
  const { body } = parseFrontmatter(skill);
  return skill.slice(0, skill.length - body.length) + zcodeReplacements(body);
}

/** A Claude Code SKILL.md in ZCode's dialect: qualified mentions, Bash search channel, no SubagentStart. */
export function toZcodeSkill(md: string, options: SkillOptions): string {
  const skill = toHarnessSkill(md, ZCODE_DIALECT, options);
  const { body } = parseFrontmatter(skill);
  return skill.slice(0, skill.length - body.length) + zcodeReplacements(body);
}

/**
 * ZCode parses hook stdout as JSON under a strict schema and discards anything
 * else [S:zcode-guide diagnosing-hooks pitfall 8], so every prose payload rides
 * `hookSpecificOutput.additionalContext` — the Claude Code scripts' plain-text
 * SessionStart stdout would be dropped. Wraps `<command>`'s stdout for `<event>`.
 */
function contextHookScript(event: "SessionStart" | "PreToolUse", description: string, command: string): string {
  return `#!/bin/bash
# ZCode ${event} hook — generated by scripts/gen-harness-zcode.ts, do not edit.
# ${description}
# ZCode parses hook stdout as JSON (strict schema), so the payload rides
# hookSpecificOutput.additionalContext. Nothing here fails the hook.

cat > /dev/null
ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
CONTEXT=$(${command} 2>/dev/null)
if [ -z "$CONTEXT" ]; then
  exit 0
fi

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "${event}",
    additionalContext: $context
  }
}'
exit 0
`;
}

/** SessionStart: the core rules (Claude plugin's `inject-rules.sh`, shipped verbatim) wrapped as context. */
const SESSION_RULES_SCRIPT = contextHookScript(
  "SessionStart",
  "The tea-rags core rules (scripts/inject-rules.sh --part 1 --parts 1) as additionalContext.",
  `bash "$ROOT/scripts/inject-rules.sh" --part 1 --parts 1`,
);

/**
 * SessionStart: the prime digest plus the stale-build warning of `check-build-fresh.sh`
 * (the Claude plugin's script, shipped verbatim), one additionalContext payload.
 */
const SESSION_DIGEST_SCRIPT = `#!/bin/bash
# ZCode SessionStart hook — generated by scripts/gen-harness-zcode.ts, do not edit.
# Hands \`tea-rags prime --agent <project>\` plus the stale-build warning of
# scripts/check-build-fresh.sh to the main session as additionalContext. A missing
# CLI or empty digest emits nothing. Nothing here fails the hook.

cat > /dev/null
ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT="\${CLAUDE_PROJECT_DIR:-$PWD}"
DIGEST=""
if command -v tea-rags >/dev/null 2>&1; then
  DIGEST=$(tea-rags prime --agent "$PROJECT" 2>/dev/null)
fi
CONTEXT="$DIGEST"
if [ -n "$DIGEST" ] && [ -f "$ROOT/scripts/check-build-fresh.sh" ]; then
  WARNING=$(bash "$ROOT/scripts/check-build-fresh.sh" 2>/dev/null)
  if [ -n "$WARNING" ]; then
    CONTEXT="$CONTEXT

$WARNING"
  fi
fi
if [ -z "$CONTEXT" ]; then
  exit 0
fi

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $context
  }
}'
exit 0
`;

/**
 * PreToolUse(Agent|Task): ZCode has no SubagentStart event, so the tea-rags
 * search block reaches subagent dispatch through the Agent tool's PreToolUse
 * hook — additionalContext, the same channel and block text the Claude Code
 * SubagentStart hook injects. Whether ZCode forwards this additionalContext
 * into the subagent's own context (Claude Code's documented PreToolUse(Task)
 * behavior) is UNVERIFIED in a live install — MANUAL-TEST.md check 6 settles
 * it; the main-session core rules steer the dispatcher meanwhile. The block is
 * scripts/subagent-block.txt, the alias resolved from the subagent's own cwd
 * (stdin `.cwd`, never CLAUDE_PROJECT_DIR: a worktree subagent reads its own
 * tree). Never blocks the dispatch.
 */
const SUBAGENT_CONTEXT_SCRIPT = `#!/bin/bash
# ZCode PreToolUse hook (Agent|Task) — generated by scripts/gen-harness-zcode.ts, do not edit.
# Hands the tea-rags subagent search block (scripts/subagent-block.txt) to the
# subagent dispatch as additionalContext, prefixed with the repository's project
# alias when tea-rags resolves one from the dispatch cwd. Nothing here fails the hook.

INPUT=$(cat)
ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
BLOCK=$(cat "$ROOT/scripts/subagent-block.txt" 2>/dev/null)
if [ -z "$BLOCK" ]; then
  exit 0
fi

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
CWD="\${CWD:-$PWD}"
ALIAS=""
if command -v tea-rags >/dev/null 2>&1; then
  ALIAS=$(tea-rags project exist --path "$CWD" --repository --print-name 2>/dev/null | head -n 1)
fi
if [ -n "$ALIAS" ]; then
  BLOCK="tea-rags project alias for this repository: \\\`\${ALIAS}\\\` — pass project=\\"\${ALIAS}\\" together with path=<your working directory> on every tea-rags call.
\${BLOCK}"
fi

jq -n --arg context "$BLOCK" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $context
  }
}'
exit 0
`;

/**
 * PostToolUse(Bash): the Claude plugin's worktree-clone cleanup, run for its side
 * effect with stdout discarded — ZCode would parse it as JSON and mark the run
 * failed (plain text), and the cleanup has nothing to say to the model.
 */
const CLEANUP_SCRIPT = `#!/bin/bash
# ZCode PostToolUse hook (Bash) — generated by scripts/gen-harness-zcode.ts, do not edit.
# Drops tea-rags worktree clones whose worktree is gone after a git worktree
# teardown, through cleanup-worktree-clone.sh (the Claude plugin's script,
# shipped verbatim). Never fails the tool.

cat > /dev/null
ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
if command -v tea-rags >/dev/null 2>&1 && [ -f "$ROOT/scripts/cleanup-worktree-clone.sh" ]; then
  PATH="$(dirname "$(command -v tea-rags)"):$PATH" bash "$ROOT/scripts/cleanup-worktree-clone.sh" >/dev/null 2>&1
fi
exit 0
`;

/**
 * Codex/Cursor wire the tea-rags MCP tools under a bare name; ZCode keeps the
 * Claude Code `mcp__<server>__<tool>` naming (the server name survives
 * normalization — hyphens are legal), so matchers spell the hyphen and the
 * underscore both.
 */
const TEA_RAGS_MCP_TOOL_MATCHER = "^mcp__.*tea[-_]rags.*__";

/** The shared reread ledger (Node script) — ZCode payloads are Claude-shaped; the ledger maps zcode→claude. */
const LEDGER_COMMAND = `node "${PLUGIN_ROOT_VAR}/scripts/reread-ledger.mjs"`;

/** The dinopowers wrapper routing handed to a subagent dispatch (PreToolUse(Agent|Task)). */
const WRAPPER_ROUTING_SCRIPT = `#!/bin/bash
# ZCode PreToolUse hook (Agent|Task) — generated by scripts/gen-harness-zcode.ts, do not edit.
# Hands the dinopowers wrapper routing table (scripts/wrapper-routing.txt) to the
# subagent dispatch as additionalContext. Nothing here fails the hook.

cat > /dev/null
ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
CONTEXT=$(cat "$ROOT/scripts/wrapper-routing.txt" 2>/dev/null)
if [ -z "$CONTEXT" ]; then
  exit 0
fi

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $context
  }
}'
exit 0
`;

interface HookSpec {
  command: string;
  timeout: number;
  statusMessage: string;
}

function hookEntry(matcher: string | undefined, hooks: HookSpec[]) {
  return { ...(matcher === undefined ? {} : { matcher }), hooks: hooks.map((h) => ({ type: "command", ...h })) };
}

/** `dinopowers/**`: wrappers as `dino-<s>`, the routing tables at SessionStart and subagent dispatch. */
function renderZcodeDinopowers(root: string, teaRagsSkills: ReadonlySet<string>) {
  const pluginRoot = join(root, DINOPOWERS_SRC);
  const manifest = readManifest(pluginRoot);
  const mentionable = new Set([...teaRagsSkills, ...wrapperNames(root)]);
  const { files, skills } = renderDinopowersSkills(
    root,
    { skill: toZcodeWrapperSkill, text: zcodeWrapperText },
    mentionable,
  );
  for (const [event, hook, script, textFile] of [
    ["SessionStart", ROUTING_HOOKS.mainSession, "main-session-routing.sh", ROUTING_HOOKS.mainSession.text],
    ["PreToolUse", ROUTING_HOOKS.subagent, "wrapper-routing-agent.sh", ROUTING_HOOKS.subagent.text],
  ] as const) {
    const context = toHarnessText(
      hookContext(root, hook.script, hook.variable),
      ZCODE_WRAPPER_DIALECT,
      mentionable,
      true,
    );
    files.set(`${DINOPOWERS_NAME}/scripts/${textFile}`, `${context}\n`);
    if (event === "SessionStart") {
      // The Claude plugin's script already answers SessionStart additionalContext — shipped verbatim.
      files.set(`${DINOPOWERS_NAME}/scripts/${script}`, readFileSync(join(pluginRoot, "scripts", hook.script), "utf8"));
    } else {
      files.set(`${DINOPOWERS_NAME}/scripts/${script}`, WRAPPER_ROUTING_SCRIPT);
    }
  }
  files.set(
    `${DINOPOWERS_NAME}/hooks/hooks.json`,
    json({
      description: "Dinopowers workflow routing for the main session and subagent dispatches",
      hooks: {
        SessionStart: [
          hookEntry(undefined, [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/main-session-routing.sh"`,
              timeout: 10,
              statusMessage: "Dinopowers: load workflow routing",
            },
          ]),
        ],
        PreToolUse: [
          hookEntry("^(Agent|Task)$", [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/wrapper-routing-agent.sh"`,
              timeout: 10,
              statusMessage: "Dinopowers: load subagent workflow routing",
            },
          ]),
        ],
      },
    }),
  );
  files.set(
    `${DINOPOWERS_NAME}/.zcode-plugin/plugin.json`,
    json({
      name: DINOPOWERS_NAME,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
    }),
  );
  return { version: manifest.version, files, skills };
}

/** `tea-rags-setup/**`: the install and tune skills plus the Node helpers they run; manifest `skills` only. */
function renderZcodeSetup(root: string, teaRagsSkills: ReadonlySet<string>): Map<string, string> {
  const manifest = readManifest(join(root, SETUP_SRC));
  const files = renderSetupPackage(root, { skill: toZcodeSkill, text: zcodeText }, teaRagsSkills);
  files.set(
    `${SETUP_NAME}/.zcode-plugin/plugin.json`,
    json({
      name: SETUP_NAME,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      skills: "./skills/",
    }),
  );
  return files;
}

function readme(version: string, skills: { name: string }[], hasCore: boolean, dinopowersVersion: string): string {
  const core = hasCore
    ? "- `tea-rags/scripts/session-rules.sh` — SessionStart: `rules/core.md` (through `inject-rules.sh`) as `additionalContext`."
    : "- `rules/core.md` does not exist yet: `session-rules.sh` emits nothing until it lands.";
  return `# tea-rags for ZCode

GENERATED by \`scripts/gen-harness-zcode.ts\` from \`plugins/tea-rags/\` and \`plugins/dinopowers/\` — do not edit.
tea-rags ${version}, dinopowers ${dinopowersVersion}.

Rendered from \`plugins/**/skills/**\`, \`plugins/tea-rags/rules/core.md\` and the plugin version. Try an edit
locally with \`npm run gen:harness-zcode\`; the release regenerates this package and commits it.

## Layout

This directory is a ZCode marketplace root: add it (**Plugin Management → Discover → +**) as a local
directory, then install \`tea-rags\` (and \`dinopowers\`, \`tea-rags-setup\` as needed) from it.

- \`marketplace.json\` — the marketplace catalog; \`source\` = \`./<plugin>\`, \`icon\` = the committed
  \`assets/icons/<plugin>.png\` over \`raw.githubusercontent.com\` (the app draws only \`https://\` icons;
  the same PNG also ships as \`<plugin>/icon.png\` so the package stays self-contained).
- \`tea-rags/.zcode-plugin/plugin.json\` — manifest: \`skills\`, \`hooks\`, \`mcpServers\`.
- \`tea-rags/.mcp.json\` — stdio server \`tea-rags server\`, auto-connected with the plugin.
- \`tea-rags/hooks/hooks.json\` — the wiring, ZCode's seven events only:
  SessionStart \`${PLUGIN_ROOT_VAR}/scripts/session-rules.sh\` (core rules as additionalContext — ZCode
  parses hook stdout as JSON under a strict schema, so the Claude plugin's plain-text SessionStart
  output is wrapped), then \`session-digest.sh\` (\`tea-rags prime\` + the stale-build warning), then the
  read-ledger reset; UserPromptSubmit \`turn-routing.sh --harness zcode\`, \`search-drift.sh --harness zcode\`
  and the ledger (per-turn routing re-inject, drift counter reset, read steering);
  PreToolUse (\`Grep|Bash\`) \`search-drift.sh\` — \`permissionDecision: "deny"\` once after 3 concept-shaped
  text searches with no tea-rags call (one deny per 120 s; literal searches and config / spec / migration
  paths neutral; reads never denied); PreToolUse (\`Read|Bash\` | \`mcp__*tea-rags*__find_symbol\`) and
  PostToolUse the ledger; PostToolUse (\`Bash\`) \`cleanup-clone.sh\` (worktree-clone cleanup, side effect
  only); PreToolUse (\`Agent|Task\`) \`subagent-context.sh\` — **ZCode has no SubagentStart event**, so the
  subagent search block (Claude Code's \`enforce-tearags-search.sh\` payload) rides the Agent tool's
  PreToolUse additionalContext; forwarding into the subagent's own context is UNVERIFIED in a live
  install — MANUAL-TEST.md check 6.
- \`tea-rags/skills/\` — every user-invocable tea-rags skill plus each internal skill a shipped skill names.
- \`tea-rags/repair/\`, \`tea-rags/rules/\` — plugin files the skills link to by relative path.
- \`dinopowers/\` — the wrappers as \`skills/dino-<s>/\` (clear of the superpowers skills they wrap; not
  bundled — https://github.com/obra/superpowers), routing tables at SessionStart and subagent dispatch.
- \`tea-rags-setup/\` — the install and tune skills plus the Node helpers they run; no hooks, no MCP.

${core}

## Install

1. Build and link the CLI: \`npm run build && npm link\` (or install the published \`tea-rags\` globally).
2. Easiest — the setup wizard: add this directory as the tea-rags marketplace, install the setup
   plugin, then run the \`tea-rags-setup:install\` skill in a ZCode session (it detects the zcode
   host and finishes everything — tea-rags plugin + MCP, registration, first index):

   \`\`\`bash
   zcode plugins marketplace add "$(npm root -g)/tea-rags/harness/zcode"   # or <repo>/harness/zcode
   zcode plugins install tea-rags-setup@tea-rags
   \`\`\`

3. Manual alternative — install the plugins directly (UI: **Plugin Management → Discover → +**, or
   CLI), from the package's own copy so the marketplace always serves the installed client's
   release:

   \`\`\`bash
   zcode plugins install tea-rags@tea-rags        # + dinopowers@tea-rags as needed
   \`\`\`

4. Review the plugin's hooks in its detail view (Settings → Plugin Management → tea-rags).
5. Development build instead of the global binary: in the installed \`.mcp.json\` set
   \`"command": "node", "args": ["<repo>/build/index.js"]\`.
6. A workspace \`tea-rags\` server (\`.zcode/config.json\` → \`mcp.servers\`) overrides the plugin's; both
   auto-connect.

## Updates

\`tea-rags update\` — manual and background alike — brings every installed \`*@tea-rags\` ZCode plugin to
the installed client's release through this marketplace: it refreshes the catalog, then updates a
plugin only when \`installed < catalog ≤ client\` — never past the client, never a downgrade. A local
tea-rags marketplace that is not the package's own \`harness/zcode\` is a developer checkout and is left
alone. The ZCode CLI is found on \`$TEA_RAGS_ZCODE_CLI\`, \`PATH\`, or the macOS app bundle
(\`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs\`).

## Transform rules

Claude Code dialect kept where ZCode matches it (Skill tool, \`tea-rags:<s>\` qualified mentions, Read
tool, \`mcp__tea-rags__<tool>\`, AskUserQuestion); \`default code search tool\` → \`Bash rg\` (ZCode sessions
ship no Grep/Glob tool; folded literals \`Bash rg "<X>" <dir>\`); \`$CLAUDE_PROJECT_DIR\` → \`$PWD\`;
\`SubagentStart\` → the subagent dispatch hook. \`tea-rags://\` resources: ZCode exposes no model-side
resource tool — the sources' inline fallback \`tea-rags resource <uri>\` (Bash) is the route.

## Facts (zcode.cjs bundle + zcode-guide plugin, 2026-11-09)

- Manifest \`.zcode-plugin/plugin.json\` (\`.claude-plugin/\`/\`.codex-plugin/\` also recognized); \`name\` must
  match \`^[a-z0-9][a-z0-9._-]{0,127}$\`; component fields \`commands\`, \`skills\`, \`hooks\`, \`mcpServers\`,
  \`agents\` (recorded, not executed).
- Hooks: exactly seven events — \`SessionStart\`, \`UserPromptSubmit\`, \`PreToolUse\`, \`PermissionRequest\`,
  \`PostToolUse\`, \`PostToolUseFailure\`, \`Stop\`. **No \`SubagentStart\`.** Matcher = case-sensitive regex on
  the tool name; \`Task\` ↔ \`Agent\` are aliases. \`timeout\` in seconds; stdout parsed as JSON (strict
  schema, extra keys fail); \`hookSpecificOutput.additionalContext\` injects; exit 2 /
  \`permissionDecision: "deny"\` blocks PreToolUse; \`updatedInput\` supported on PreToolUse (unused here —
  parallel rewrites of the Agent prompt collide).
- MCP tools: \`mcp__<server>__<tool>\`, server name normalized by \`[^a-zA-Z0-9_-]\` → \`_\` (hyphens survive):
  \`mcp__tea-rags__find_symbol\`. Plugin \`.mcp.json\` via the manifest \`mcpServers\` field; workspace
  \`.zcode/config.json\` → \`mcp.servers\` overrides it; every scope auto-connects.
- No model-side MCP resource tool in the toolset (\`ReadMcpResource\` absent from zcode.cjs): resource
  reads go through the CLI fallback.
- Marketplace: local directory root with \`marketplace.json\` (or \`.claude-plugin/marketplace.json\`);
  \`plugins[].source\` a relative path string; \`plugins[].icon\` any non-empty string in the catalog,
  but the app renderer draws only values starting with \`https://\` (its image validator, app bundle;
  six official plugins ship hardcoded data-URIs instead) — hence the raw.githubusercontent URLs and
  the pushed-to-main requirement; install/enable state in \`~/.zcode/cli/config.json\`.
- CLI (\`zcode plugins\`, verified 0.17.0): \`list [--json] [--available]\`, \`install <p>[@<market>]\`,
  \`update <p>\`, \`marketplace add|remove|update\`; \`marketplace remove\` KEEPS installed plugins;
  \`plugins update\` re-reads a directory marketplace by itself; the github source schema carries a
  \`ref\`, but \`marketplace add\` exposes no ref flag — hence the update guards above instead of a pin.
`;
}

const MANUAL_TEST = `# ZCode manual test — tea-rags harness

GENERATED by \`scripts/gen-harness-zcode.ts\` — do not edit. Record pass/fail, the tool calls seen and any
deviation next to each check; then move the record into the repository benchmarks.

## Setup

1. \`npm run build\`; install per \`README.md\` (marketplace = this directory). Note the ZCode version.
2. Open an indexed repository (this repo aliases \`tea-rags\`).

## Checks

1. **Plugin loads** — Settings → Plugin Management → Installed lists \`tea-rags\` (enabled); the MCP server
   \`tea-rags\` connects (Settings → MCP); skills appear in the \`/\` composer picker (\`tea-rags:explore\` …);
   the plugin detail view lists every hook of \`hooks/hooks.json\`.
2. **Core rules at SessionStart** — fresh session: "Quote the first line the tea-rags core rules start
   with" before any tool call. Expect the \`# tea-rags core\` heading (additionalContext from
   \`session-rules.sh\`). If absent, run \`echo '{}' | scripts/session-rules.sh\` by hand — it must print
   \`{"hookSpecificOutput":{"hookEventName":"SessionStart",…}}\`.
3. **Prime digest** — fresh session: "What does the tea-rags digest say about this project?" Expect digest
   facts (alias, floors) with no tool call.
4. **Search routing (Bash channel)** — "Where is registerAllResources defined? Show its body." Expect
   \`mcp__tea-rags__find_symbol\`; no Bash \`rg\`/\`grep\`/\`cat\` over \`src/\`.
5. **Drift deny** — three concept alternation searches by Bash rg in one turn with no tea-rags call; the
   third must be denied with the drift reason naming \`semantic_search\`/\`hybrid_search\`.
6. **Subagent context (UNVERIFIED forward)** — "Delegate to a subagent: find every caller of
   registerAllResources." The PreToolUse(Agent) hook \`subagent-context.sh\` fires (ZCode log). Expect the
   subagent to use \`hybrid_search\`/\`get_callers\`, not grep. If it greps, ask the subagent whether its
   context names the tea-rags project alias — record whether the additionalContext reached the subagent's
   own context or only the main conversation.
7. **dinopowers routing** — with dinopowers + superpowers installed: "brainstorm a cache for
   get_index_status" → \`dino-brainstorming\` loads, chains into superpowers.
8. **Read steering** — "Read src/cli/index.ts lines 1–40 with sed." Expect one find_symbol nudge
   (additionalContext), never a deny.
`;

/**
 * The whole ZCode package as `path (relative to harness/zcode) → content`,
 * Prettier-formatted like the committed files, so a regeneration leaves no diff.
 */
export async function renderZcodeHarness(root: string): Promise<Map<string, string>> {
  const pluginRoot = join(root, PLUGIN_SRC);
  const manifest = readManifest(pluginRoot);
  const corePath = join(pluginRoot, "rules/core.md");
  const hasCore = existsSync(corePath);
  const selected = selectSkills(readSkills(pluginRoot));
  const skillNames = new Set(selected.map(({ skill }) => skill.name));

  const files = new Map<string, string>();
  for (const { skill, callers } of selected) {
    const description = skill.internal ? internalDescription(skill, callers, ZCODE_DIALECT.skillMention) : undefined;
    for (const file of walk(skill.dir)) {
      const rel = relative(skill.dir, file);
      const source = readFileSync(file, "utf8");
      const out =
        rel === "SKILL.md"
          ? toZcodeSkill(source, { skillNames, name: skill.name, description })
          : file.endsWith(".md")
            ? zcodeText(source, skillNames)
            : source;
      files.set(`${PLUGIN_NAME}/skills/${skill.name}/${rel}`, out);
    }
  }
  for (const file of linkedPluginFiles(
    pluginRoot,
    selected.flatMap(({ skill }) => walk(skill.dir)),
  )) {
    const source = readFileSync(file, "utf8");
    const out = file.endsWith(".md") ? zcodeText(source, skillNames) : source;
    files.set(`${PLUGIN_NAME}/${relative(pluginRoot, file)}`, out);
  }

  // No shipped skill links rules/core.md (the SessionStart hook injects it), so it
  // ships explicitly — session-rules.sh runs the Claude plugin's inject-rules.sh,
  // which reads $PLUGIN_ROOT/rules/core.md.
  if (hasCore) {
    const core = zcodeText(parseFrontmatter(readFileSync(corePath, "utf8")).body, skillNames);
    files.set(`${PLUGIN_NAME}/rules/core.md`, `${core.trim()}\n`);
  }

  files.set(`${PLUGIN_NAME}/scripts/session-rules.sh`, SESSION_RULES_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/session-digest.sh`, SESSION_DIGEST_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/subagent-context.sh`, SUBAGENT_CONTEXT_SCRIPT);
  files.set(`${PLUGIN_NAME}/scripts/cleanup-clone.sh`, CLEANUP_SCRIPT);
  for (const script of [
    ...SHARED_HOOK_SCRIPTS,
    "inject-rules.sh",
    "check-build-fresh.sh",
    "cleanup-worktree-clone.sh",
  ]) {
    files.set(`${PLUGIN_NAME}/scripts/${script}`, readFileSync(join(pluginRoot, "scripts", script), "utf8"));
  }
  const turnRouting = extractInjectionBlock(readFileSync(join(pluginRoot, TURN_ROUTING_SOURCE), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/turn-routing.txt`, `${zcodeText(turnRouting, skillNames)}\n`);
  const block = extractInjectionBlock(readFileSync(join(pluginRoot, "rules/references/subagent-injection.md"), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/subagent-block.txt`, `${zcodeText(block, skillNames)}\n`);

  files.set(
    `${PLUGIN_NAME}/.zcode-plugin/plugin.json`,
    json({
      name: PLUGIN_NAME,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
    }),
  );
  files.set(
    `${PLUGIN_NAME}/.mcp.json`,
    json({
      mcpServers: {
        [PLUGIN_NAME]: { type: "stdio", command: "tea-rags", args: ["server"] },
      },
    }),
  );
  files.set(
    `${PLUGIN_NAME}/hooks/hooks.json`,
    json({
      description: "TeaRAGs context, code navigation, search drift and read steering",
      hooks: {
        SessionStart: [
          hookEntry(undefined, [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/session-rules.sh"`,
              timeout: 10,
              statusMessage: "TeaRAGs: load core rules",
            },
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/session-digest.sh"`,
              timeout: 60,
              statusMessage: "TeaRAGs: load project digest",
            },
            {
              command: `${LEDGER_COMMAND} --harness zcode`,
              timeout: 10,
              statusMessage: "TeaRAGs: initialize read ledger",
            },
          ]),
        ],
        UserPromptSubmit: [
          hookEntry(undefined, [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/turn-routing.sh" --harness zcode`,
              timeout: 5,
              statusMessage: "TeaRAGs: route this request",
            },
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/search-drift.sh" --harness zcode`,
              timeout: 5,
              statusMessage: "TeaRAGs: reset search tracking",
            },
            {
              command: `${LEDGER_COMMAND} --harness zcode`,
              timeout: 5,
              statusMessage: "TeaRAGs: advance read ledger",
            },
          ]),
        ],
        PreToolUse: [
          hookEntry("Grep|Bash", [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/search-drift.sh" --harness zcode`,
              timeout: 10,
              statusMessage: "TeaRAGs: check search scope",
            },
          ]),
          hookEntry("^(Read|Bash)$|^mcp__.*tea[-_]rags.*__find_symbol$", [
            {
              command: `${LEDGER_COMMAND} --harness zcode`,
              timeout: 10,
              statusMessage: "TeaRAGs: check reused code",
            },
          ]),
          hookEntry("^(Agent|Task)$", [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/subagent-context.sh"`,
              timeout: 30,
              statusMessage: "TeaRAGs: load subagent context",
            },
          ]),
        ],
        PostToolUse: [
          hookEntry(TEA_RAGS_MCP_TOOL_MATCHER, [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/search-drift.sh" --harness zcode`,
              timeout: 5,
              statusMessage: "TeaRAGs: record search results",
            },
            {
              command: `${LEDGER_COMMAND} --harness zcode`,
              timeout: 10,
              statusMessage: "TeaRAGs: remember delivered MCP code",
            },
          ]),
          hookEntry("^Bash$", [
            {
              command: `bash "${PLUGIN_ROOT_VAR}/scripts/cleanup-clone.sh"`,
              timeout: 120,
              statusMessage: "TeaRAGs: clean stale worktree clones",
            },
          ]),
          hookEntry("^(Read|Grep|Bash|Edit|Write|MultiEdit|NotebookEdit)$|^mcp__.*tea[-_]rags.*__", [
            {
              command: `${LEDGER_COMMAND} --harness zcode`,
              timeout: 10,
              statusMessage: "TeaRAGs: remember delivered code",
            },
          ]),
        ],
      },
    }),
  );

  const dinopowers = renderZcodeDinopowers(root, skillNames);
  for (const [path, content] of dinopowers.files) files.set(path, content);
  for (const [path, content] of renderZcodeSetup(root, skillNames)) files.set(path, content);

  files.set(
    "README.md",
    readme(
      manifest.version,
      selected.map(({ skill }) => skill),
      hasCore,
      dinopowers.version,
    ),
  );
  files.set("MANUAL-TEST.md", MANUAL_TEST);
  files.set(
    ZCODE_MARKETPLACE_PATH,
    json({
      name: PLUGIN_NAME,
      plugins: HARNESS_PACKAGES.map((name) => {
        const packageManifest = name === PLUGIN_NAME ? manifest : readManifest(join(root, PLUGINS_DIR, name));
        return {
          name,
          source: `./${name}`,
          version: packageManifest.version,
          description: packageManifest.description,
          category: "developer-tools",
          // The app renderer draws only icons that start with https:// (its validator is
          // `startsWith("https://")`; aside from six hardcoded official data-URIs) — a relative
          // path passes the catalog parse but is silently dropped for the fallback glyph. So the
          // catalog points at the committed source files on GitHub; `copyIconAssets` still ships
          // `<plugin>/icon.png` so the package stays self-contained.
          icon: `${ICON_URL_BASE}/${name}.png`,
        };
      }),
    }),
  );

  return formatPackage(root, ZCODE_HARNESS_DIR, files);
}

/** Replace `harness/zcode/` with a fresh render (the marketplace lives inside it). */
export async function writeZcodeHarness(root: string): Promise<number> {
  const count = writePackage(root, ZCODE_HARNESS_DIR, await renderZcodeHarness(root));
  return count + copyIconAssets(root, ZCODE_HARNESS_DIR, HARNESS_PACKAGES);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const count = await writeZcodeHarness(root);
  console.log(
    `✓ ${ZCODE_HARNESS_DIR}: ${count} files regenerated from ${PLUGIN_SRC}, ${DINOPOWERS_SRC}, ${SETUP_SRC}.`,
  );
}
