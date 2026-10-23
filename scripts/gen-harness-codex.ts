import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format, resolveConfig } from "prettier";

import {
  extractInjectionBlock,
  firstSentence,
  parseFrontmatter,
  renderFrontmatter,
  toHarnessSkill,
  toHarnessText,
  type HarnessDialect,
  type SkillOptions,
} from "./harness/transform.js";

/** Package root, relative to the repository root. */
export const CODEX_HARNESS_DIR = "harness/codex";
/** Cap on `name + description` summed over shipped skills (Codex default list budget: 8,000 chars). */
export const SKILLS_LIST_BUDGET = 7_000;

const PLUGIN_SRC = ".claude-plugin/tea-rags";
const PLUGIN_NAME = "tea-rags";
const MARKETPLACE_NAME = "tea-rags-local";
const CORE_SKILL = "tea-rags-core";
const CORE_DESCRIPTION =
  "tea-rags core rules: code search, navigation and project data through the tea-rags MCP tools and resources. Load before any code search, navigation or code change in an indexed repository.";

/** Codex hands plugin hook commands the plugin directory as `PLUGIN_ROOT`. */
const PLUGIN_ROOT_VAR = `\${PLUGIN_ROOT}`;

const CODEX_DIALECT: HarnessDialect = {
  skillMention: (name) => `$${name}`,
  pluginRootVar: PLUGIN_ROOT_VAR,
  projectDirVar: "$PWD",
};

/** A Claude Code SKILL.md in Codex's dialect (see `toHarnessText` for the rewrite list). */
export function toCodexSkill(md: string, options: SkillOptions): string {
  return toHarnessSkill(md, CODEX_DIALECT, options);
}

interface SourceSkill {
  name: string;
  dir: string;
  internal: boolean;
  fields: Record<string, string>;
  body: string;
  /** SKILL.md + every Markdown file under the skill folder, joined — reference scan. */
  text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

function readSkills(root: string): SourceSkill[] {
  const skillsDir = join(root, PLUGIN_SRC, "skills");
  return readdirSync(skillsDir)
    .sort()
    .filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    .map((name) => {
      const dir = join(skillsDir, name);
      const { fields, body } = parseFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
      const text = walk(dir)
        .filter((file) => file.endsWith(".md"))
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      return { name, dir, internal: fields["user-invocable"] === "false", fields, body, text };
    });
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text);
}

/**
 * Every user-invocable skill, plus each internal (`user-invocable: false`) skill
 * a shipped skill names — transitively, since the referencing skill calls it at
 * runtime. Internal skills get a short description naming their callers, so the
 * skills list stays within budget.
 */
export function selectSkills(skills: SourceSkill[]): { skill: SourceSkill; callers: string[] }[] {
  const shipped = new Set(skills.filter((skill) => !skill.internal).map((skill) => skill.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const skill of skills) {
      if (shipped.has(skill.name)) continue;
      if (skills.some((other) => shipped.has(other.name) && mentions(other.text, skill.name))) {
        shipped.add(skill.name);
        grew = true;
      }
    }
  }
  return skills
    .filter((skill) => shipped.has(skill.name))
    .map((skill) => ({
      skill,
      callers: skills
        .filter((other) => other.name !== skill.name && shipped.has(other.name) && mentions(other.text, skill.name))
        .map((other) => other.name),
    }));
}

function internalDescription(skill: SourceSkill, callers: string[]): string {
  const purpose = firstSentence(skill.fields.description || skill.body);
  return `Internal step invoked by ${callers.map(CODEX_DIALECT.skillMention).join(", ")}. ${purpose}`;
}

/**
 * Plugin files outside `skills/` that shipped Markdown links to by relative path
 * (`../../repair/<family>.md` → the whole `repair/` folder), transitively. They
 * keep their plugin-relative place, so the links resolve unchanged.
 */
export function linkedPluginFiles(pluginRoot: string, seeds: string[]): string[] {
  const skillsDir = join(pluginRoot, "skills");
  const found = new Set<string>();
  const queue = seeds.filter((file) => file.endsWith(".md"));
  while (queue.length > 0) {
    const from = queue.pop() as string;
    for (const [link] of readFileSync(from, "utf8").matchAll(/(?:\.\.\/)+[\w./<>-]+/g)) {
      const target = resolve(dirname(from), link.split("<")[0]);
      const inside = relative(pluginRoot, target);
      if (inside.startsWith("..") || !relative(skillsDir, target).startsWith("..") || !existsSync(target)) continue;
      for (const file of statSync(target).isDirectory() ? walk(target) : [target]) {
        if (found.has(file)) continue;
        found.add(file);
        if (file.endsWith(".md")) queue.push(file);
      }
    }
  }
  return [...found].sort();
}

async function formatted(root: string, path: string, content: string): Promise<string> {
  const filepath = join(root, CODEX_HARNESS_DIR, path);
  const config = await resolveConfig(filepath);
  return format(content, { ...config, filepath });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const SUBAGENT_SCRIPT = `#!/bin/bash
# Codex SubagentStart hook — generated by scripts/gen-harness-codex.ts, do not edit.
# Hands every subagent the tea-rags search block (scripts/subagent-block.txt) as
# hookSpecificOutput.additionalContext, prefixed with the repository's project
# alias when tea-rags resolves one. Nothing here fails the hook.

INPUT=$(cat)
ROOT="\${PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
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
    hookEventName: "SubagentStart",
    additionalContext: $context
  }
}'
exit 0
`;

interface ShippedSkill {
  name: string;
  description: string;
}

function readme(version: string, skills: ShippedSkill[], hasCore: boolean): string {
  const rows = skills.map((skill) => `| \`${skill.name}\` | ${skill.name.length + skill.description.length} |`);
  const total = skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length, 0);
  const core = hasCore
    ? "- `tea-rags/skills/tea-rags-core/` — `rules/core.md` as an always-relevant skill; `AGENTS.tea-rags.md` — the same text for your `AGENTS.md` (plugins cannot ship AGENTS.md)."
    : "- `rules/core.md` does not exist yet: no `tea-rags-core` skill and no `AGENTS.tea-rags.md` are emitted. They appear on the first `npm run gen:harness-codex` after it lands.";
  return `# tea-rags for Codex CLI

GENERATED by \`scripts/gen-harness-codex.ts\` from \`.claude-plugin/tea-rags/\` — do not edit.
Plugin version ${version}.

**Regenerate after every edit** to \`.claude-plugin/**/skills/**\`, \`.claude-plugin/tea-rags/rules/core.md\`,
\`rules/references/subagent-injection.md\` or the plugin version: \`npm run gen:harness-codex\`.
\`tests/scripts/gen-harness-codex.test.ts\` fails while the committed package lags the sources.

## Layout

- \`.agents/plugins/marketplace.json\` — local marketplace \`${MARKETPLACE_NAME}\`; this directory is its root.
- \`tea-rags/.codex-plugin/plugin.json\` — manifest: \`skills\`, \`mcpServers\`, \`hooks\` paths.
- \`tea-rags/.mcp.json\` — stdio server \`tea-rags server\`, tool calls pre-approved.
- \`tea-rags/hooks/hooks.json\` — SessionStart \`tea-rags prime "$PWD"\` (stdout = context);
  SubagentStart \`\${PLUGIN_ROOT}/scripts/subagent-block.sh\` (\`hookSpecificOutput.additionalContext\`).
- \`tea-rags/skills/\` — curated tea-rags skills (below).
- \`tea-rags/repair/\`, \`tea-rags/rules/references/\` — plugin files the skills link to by relative path.
${core}

## Install

\`\`\`bash
codex plugin marketplace add <repo>/harness/codex
codex plugin add ${PLUGIN_NAME}@${MARKETPLACE_NAME}
\`\`\`

Then review the plugin hooks in \`/hooks\` (plugin hooks stay untrusted until reviewed; \`codex exec\`
takes \`--dangerously-bypass-hook-trust\` for one run). Development build instead of the global
binary: in the installed \`.mcp.json\` set \`"command": "node", "args": ["<repo>/build/index.js"]\`.

## Skills

Shipped: every user-invocable tea-rags skill, plus each internal skill a shipped skill names
(transitively) — those run inside the callers' workflows, so they ship with a short description
naming their callers. dinopowers wrappers are excluded: they chain into superpowers skills Codex does
not ship. Skills list budget: ${total} / ${SKILLS_LIST_BUDGET} chars (\`name + description\`).

| Skill | chars |
| ----- | ----- |
${rows.join("\n")}

## Transform rules

Load-time \`\` !\`…\` \`\` blocks dropped (the model-read line beside them stays);
\`ReadMcpResourceTool\` → \`read_mcp_resource\`; \`mcp__tea-rags__<tool>\` → \`<tool>\`;
\`Skill(tea-rags:<s>)\` / \`/tea-rags:<s>\` / \`tea-rags:<s>\` → \`$<s>\`; \`dinopowers:<s>\` → \`<s>\`;
Agent-tool passages → "spawn a subagent"; \`AskUserQuestion\` → ask the user;
\`CLAUDE_PLUGIN_ROOT\` → \`PLUGIN_ROOT\`, \`CLAUDE_PROJECT_DIR\` → \`PWD\`; frontmatter → \`name\` + \`description\`.

## Facts (codex-cli 0.162.1; full list with sources: \`docs/superpowers/specs/2026-10-23-harness-facts.md\` §A)

- Manifest \`.codex-plugin/plugin.json\`; paths start with \`./\` [S:codex-rs/core-plugins/src/manifest.rs].
- Plugin hooks default to \`hooks/hooks.json\`; commands get \`PLUGIN_ROOT\`, \`PLUGIN_DATA\`; untrusted until
  reviewed in \`/hooks\` [D:learn.chatgpt.com/docs/hooks].
- Plain stdout is context for SessionStart / UserPromptSubmit / SubagentStart; structured
  \`hookSpecificOutput.additionalContext\`; ~2,500 tokens per hook output [D:hooks].
- Skills list = 2% of context (8,000 chars default); descriptions shortened first, skills omitted with a
  warning [D:learn.chatgpt.com/docs/build-skills].
- No manifest field bundles AGENTS.md — core rules go into a skill and a user AGENTS.md snippet.
- Resource tools: \`list_mcp_resources\`, \`read_mcp_resource{server, uri}\` [S:mcp_resource_spec.rs]; model-visible
  MCP tool names may carry an \`mcp__<server>__\` prefix — prose names tools bare.
- Verified locally (2026-10-23): \`codex plugin --help\` → \`add | list | marketplace | remove\`;
  \`codex plugin marketplace --help\` → \`add | list | upgrade | remove\`; \`marketplace add <SOURCE>\` takes a local
  path; \`plugin add <PLUGIN[@MARKETPLACE]>\`. A local marketplace root holds \`.agents/plugins/marketplace.json\`
  with \`source.path\` relative to the root [L:~/.codex/.tmp/bundled-marketplaces/openai-bundled].
- \`.mcp.json\` \`type\`: stdio entries in shipped plugins carry no \`type\` (3 of 3); only the HTTP entry has
  \`"type": "http"\` [L:~/.codex/plugins/cache/**/.mcp.json] — the stdio entry here omits it.
`;
}

/**
 * The whole Codex package as `path (relative to harness/codex) → content`,
 * Prettier-formatted like the committed files, so the drift guard compares bytes.
 */
export async function renderCodexHarness(root: string): Promise<Map<string, string>> {
  const pluginRoot = join(root, PLUGIN_SRC);
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as {
    version: string;
    description: string;
  };
  const corePath = join(pluginRoot, "rules/core.md");
  const hasCore = existsSync(corePath);
  const selected = selectSkills(readSkills(root));
  const skillNames = new Set(selected.map(({ skill }) => skill.name));
  if (hasCore) skillNames.add(CORE_SKILL);

  const files = new Map<string, string>();
  const shipped: ShippedSkill[] = [];
  for (const { skill, callers } of selected) {
    const description = skill.internal ? internalDescription(skill, callers) : undefined;
    for (const file of walk(skill.dir)) {
      const rel = relative(skill.dir, file);
      const source = readFileSync(file, "utf8");
      const out =
        rel === "SKILL.md"
          ? toCodexSkill(source, { skillNames, name: skill.name, description })
          : file.endsWith(".md")
            ? toHarnessText(source, CODEX_DIALECT, skillNames)
            : source;
      files.set(`${PLUGIN_NAME}/skills/${skill.name}/${rel}`, out);
    }
    const rendered = parseFrontmatter(files.get(`${PLUGIN_NAME}/skills/${skill.name}/SKILL.md`) ?? "").fields;
    shipped.push({ name: skill.name, description: rendered.description });
  }
  for (const file of linkedPluginFiles(
    pluginRoot,
    selected.flatMap(({ skill }) => walk(skill.dir)),
  )) {
    const source = readFileSync(file, "utf8");
    const out = file.endsWith(".md") ? toHarnessText(source, CODEX_DIALECT, skillNames) : source;
    files.set(`${PLUGIN_NAME}/${relative(pluginRoot, file)}`, out);
  }

  if (hasCore) {
    const core = toHarnessText(parseFrontmatter(readFileSync(corePath, "utf8")).body, CODEX_DIALECT, skillNames);
    files.set(`${PLUGIN_NAME}/skills/${CORE_SKILL}/SKILL.md`, renderFrontmatter(CORE_SKILL, CORE_DESCRIPTION) + core);
    files.set("AGENTS.tea-rags.md", core);
    shipped.unshift({ name: CORE_SKILL, description: CORE_DESCRIPTION });
  }

  const block = extractInjectionBlock(readFileSync(join(pluginRoot, "rules/references/subagent-injection.md"), "utf8"));
  files.set(`${PLUGIN_NAME}/scripts/subagent-block.txt`, `${toHarnessText(block, CODEX_DIALECT, skillNames)}\n`);
  files.set(`${PLUGIN_NAME}/scripts/subagent-block.sh`, SUBAGENT_SCRIPT);

  files.set(
    `${PLUGIN_NAME}/.codex-plugin/plugin.json`,
    json({
      name: PLUGIN_NAME,
      version: manifest.version,
      description: manifest.description,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
    }),
  );
  files.set(
    `${PLUGIN_NAME}/.mcp.json`,
    json({
      mcpServers: {
        [PLUGIN_NAME]: { command: "tea-rags", args: ["server"], default_tools_approval_mode: "approve" },
      },
    }),
  );
  files.set(
    `${PLUGIN_NAME}/hooks/hooks.json`,
    json({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: 'tea-rags prime "$PWD"', timeout: 15 }] }],
        SubagentStart: [
          { hooks: [{ type: "command", command: `${PLUGIN_ROOT_VAR}/scripts/subagent-block.sh`, timeout: 10 }] },
        ],
      },
    }),
  );
  files.set(
    ".agents/plugins/marketplace.json",
    json({
      name: MARKETPLACE_NAME,
      interface: { displayName: "tea-rags (local)" },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: "local", path: `./${PLUGIN_NAME}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
    }),
  );
  files.set("README.md", readme(manifest.version, shipped, hasCore));

  const out = new Map<string, string>();
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    out.set(path, /\.(md|json)$/.test(path) ? await formatted(root, path, content) : content);
  }
  return out;
}

/** Replace `harness/codex/` with a fresh render; shell scripts made executable. */
export async function writeCodexHarness(root: string): Promise<number> {
  const rendered = await renderCodexHarness(root);
  const dir = join(root, CODEX_HARNESS_DIR);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of rendered) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    if (path.endsWith(".sh")) chmodSync(target, 0o755);
  }
  return rendered.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const count = await writeCodexHarness(root);
  console.log(`✓ ${CODEX_HARNESS_DIR}: ${count} files regenerated from ${PLUGIN_SRC}.`);
}
