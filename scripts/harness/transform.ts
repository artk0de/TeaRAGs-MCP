/**
 * Harness-neutral transform core: rewrites Claude Code plugin prose (skills,
 * the subagent block, the core rules) into the dialect of another agent
 * harness. Each generator (`scripts/gen-harness-codex.ts`,
 * `scripts/gen-harness-cursor.ts`) plugs in its own `HarnessDialect`.
 */

/**
 * One concrete tool list per harness for the roles sources name abstractly (bd tea-rags-mcp-onli7) —
 * an abstract "native tool" phrase is read differently by each harness. Every package, Claude Code's
 * included, ships the concrete names; only the MCP server instructions stay harness-neutral.
 */
export interface CodeToolNames {
  /**
   * The client's own literal text search, named where sources say "default code search tool".
   * Bounded by default — files-with-matches first: Claude Code / Cursor `Grep tool`, Codex `shell rg -l`
   * (rg ships inside Codex; `grep -rl` ignores .gitignore and never finished on a whole repo).
   */
  codeSearchTool: string;
  /**
   * The client's own file reader, named where sources say "default code read tool": Claude Code /
   * Cursor `Read tool`, Codex `shell sed -n '<start>,<end>p' <one file>` (one file per command, enforced
   * by its `one-file-read.sh` hook).
   */
  codeReadTool: string;
}

export interface HarnessDialect extends CodeToolNames {
  /** How a skill is mentioned in prose: Codex `$explore`, Cursor `/explore`. */
  skillMention: (name: string) => string;
  /** Replacement for `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRootVar: string;
  /** Replacement for `$CLAUDE_PROJECT_DIR` / `${CLAUDE_PROJECT_DIR}`. */
  projectDirVar: string;
  /** Model-side tool reading an MCP resource: Codex `read_mcp_resource`, Cursor `FetchMcpResource`. */
  readResourceTool: string;
  /** Model-side tool listing MCP resources: Codex `list_mcp_resources`, Cursor `ListMcpResources`. */
  listResourcesTool: string;
  /** Skills list names plugin skills `superpowers:Y` (Codex) — the availability clause keeps that form. */
  listsQualifiedSkills?: boolean;
}

export interface Frontmatter {
  /** Top-level keys in file order; folded continuation lines joined by a space. */
  fields: Record<string, string>;
  /** Everything after the closing `---`. */
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/** YAML block scalar indicator: `>` folds lines with spaces, `|` keeps newlines. */
const BLOCK_SCALAR = /^([>|])[-+]?$/;

/**
 * Lenient frontmatter reader: values are taken as text, line by line. Sources
 * must still parse as strict YAML — Claude Code drops a skill whose
 * frontmatter does not from the model's listing (bd tea-rags-mcp-zes6j) — so
 * descriptions are written as `>-` block scalars, read here like YAML reads them.
 */
export function parseFrontmatter(md: string): Frontmatter {
  const match = FRONTMATTER.exec(md);
  if (!match) return { fields: {}, body: md };
  const fields: Record<string, string> = {};
  let key: string | null = null;
  let separator = " ";
  for (const line of match[1].split("\n")) {
    const keyLine = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (keyLine) {
      key = keyLine[1];
      const value = keyLine[2].trim();
      const block = BLOCK_SCALAR.exec(value);
      separator = block?.[1] === "|" ? "\n" : " ";
      fields[key] = block ? "" : value;
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = fields[key] === "" ? line.trim() : `${fields[key]}${separator}${line.trim()}`;
    }
  }
  for (const [name, value] of Object.entries(fields)) {
    if (/^(".*"|'.*')$/.test(value)) fields[name] = unquote(value);
  }
  return { fields, body: md.slice(match[0].length) };
}

/**
 * `md` without the top-level frontmatter `key` and its indented continuation
 * lines; every other byte kept. No frontmatter or no such key → `md` unchanged.
 */
export function stripFrontmatterKey(md: string, key: string): string {
  const match = FRONTMATTER.exec(md);
  if (!match) return md;
  const kept: string[] = [];
  let dropping = false;
  for (const line of match[1].split("\n")) {
    const keyLine = /^([A-Za-z][\w-]*):/.exec(line);
    if (keyLine) dropping = keyLine[1] === key;
    else if (!/^\s+\S/.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  return `---\n${kept.join("\n")}\n---${md.slice(match[0].length - (match[0].endsWith("\n") ? 1 : 0))}`;
}

function unquote(value: string): string {
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

/** `---` block with `name` + `description`, the only keys other harnesses read. */
export function renderFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

/** First sentence of the first prose paragraph of a body (headings skipped). */
export function firstSentence(text: string): string {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block !== "" && !block.startsWith("#")) ?? "";
  const flat = paragraph.replace(/\s+/g, " ");
  const end = /[.!?](\s|$)/.exec(flat);
  return end ? flat.slice(0, end.index + 1) : flat;
}

/**
 * Drop Claude Code load-time shell blocks (`` !`cmd` ``), with an optional
 * double-backtick code-span wrapper. A `!` right after a backtick (`` `!`/`?` ``)
 * is literal text, not a block. A line left blank by the drop goes with it; the
 * model-read line beside the block stays — other harnesses have no load-time
 * shell.
 */
export function dropLoadTimeBlocks(md: string): string {
  const block = /(?:``\s?)?(?<![`\w])!`[^`\n]+`(?:\s?``)?/g;
  return md
    .split("\n")
    .flatMap((line) => {
      const dropped = line.replace(block, "");
      if (dropped === line) return [line];
      return dropped.trim() === "" ? [] : [dropped.replace(/(\S) {2,}/g, "$1 ").replace(/\s+$/, "")];
    })
    .join("\n");
}

/** Body of the first fenced block under `## The block to inject`. */
export function extractInjectionBlock(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## The block to inject"));
  if (start === -1) throw new Error('"## The block to inject" heading not found');
  const open = lines.findIndex((line, i) => i > start && line.startsWith("```"));
  const close = lines.findIndex((line, i) => i > open && line.startsWith("```"));
  if (open === -1 || close === -1) throw new Error("no fenced block under the inject heading");
  return lines.slice(open + 1, close).join("\n");
}

/**
 * Prose rewrites, in order:
 * 1. load-time blocks dropped;
 * 2. `ReadMcpResourceTool` / `ListMcpResourcesTool` → the dialect's resource tools;
 * 3. `mcp__tea-rags__<tool>` → bare `<tool>` (the harness may prefix or not);
 * 4. `Skill(tea-rags:<s>)`, `/tea-rags:<s>`, `tea-rags:<s>` → dialect mention, for known skills only;
 * 5. `dinopowers:<s>` / `superpowers:<s>` → bare `<s>` (named as the workflow) — or, with `wrappers`
 *    (the dinopowers package itself), `Skill(dinopowers:<s>)` / `dinopowers:<s>` → mention of
 *    `dino-<s>` and `Skill(superpowers:<s>)` / `superpowers:<s>` → mention of `<s>`;
 * 6. Agent-tool passages → "spawn a subagent", `subagent_type:` lines dropped;
 * 7. `AskUserQuestion` → asking the user;
 * 8. `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PROJECT_DIR` → dialect variables;
 * 9. "(the) default code search tool" / "(the) default code read tool", line breaks and a capital
 *    first letter included → the dialect's text search / file reader ({@link nameCodeTools}).
 */
export function toHarnessText(
  md: string,
  dialect: HarnessDialect,
  skillNames: ReadonlySet<string>,
  wrappers = false,
): string {
  const mention = (name: string, fallback: string): string =>
    skillNames.has(name) ? dialect.skillMention(name) : fallback;
  const text = dropLoadTimeBlocks(md)
    .replace(/\bReadMcpResourceTool\b/g, dialect.readResourceTool)
    .replace(/\bListMcpResourcesTool\b/g, dialect.listResourcesTool)
    .replace(/\bmcp__tea-rags__(\w+)/g, "$1")
    .replace(/\bSkill\(\s*(?:skill:\s*)?"?tea-rags:([a-z0-9-]+)"?[^)]*\)/g, (whole, name: string) =>
      mention(name, whole),
    )
    .replace(/(?<![\w/])\/?tea-rags:([a-z0-9-]+)(?![\w/-])/g, (whole, name: string) => mention(name, whole));
  const rewritten = (
    wrappers ? wrapperMentions(text, dialect) : text.replace(/\b(?:dinopowers|superpowers):([a-z0-9-]+)/g, "$1")
  )
    .replace(/\s*\(`?Agent`? tool\)/g, "")
    .replace(/^(\s*)`?Agent`? tool:/gm, "$1Spawn a subagent:")
    .replace(/\b(?:the )?`?Agent`? tool\b/g, "a subagent")
    .replace(/^[ \t]*subagent_type:.*\n/gm, "")
    .replace(/\b(?:using|via) `?AskUserQuestion`?/g, "by asking the user")
    .replace(/`?AskUserQuestion`?/g, "ask the user")
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, dialect.pluginRootVar)
    .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g, dialect.projectDirVar);
  return nameCodeTools(rewritten, dialect);
}

/** A sentence-initial role phrase keeps its capital on the concrete name (`Default code read tool` → `Read tool`). */
function withCaseOf(match: string, name: string): string {
  return /^[A-Z]/.test(match) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * `toHarnessText` rule 9 on its own: "(the) default code search tool" / "(the) default code read
 * tool", line breaks and a capital first letter included → `tools`' concrete names. The Claude Code
 * package runs only this rule; its sources are already in the Claude Code dialect otherwise.
 */
export function nameCodeTools(md: string, tools: CodeToolNames): string {
  return md
    .replace(/\b(?:[Tt]he\s+)?[Dd]efault\s+code\s+search\s+tool\b/g, (match) => withCaseOf(match, tools.codeSearchTool))
    .replace(/\b(?:[Tt]he\s+)?[Dd]efault\s+code\s+read\s+tool\b/g, (match) => withCaseOf(match, tools.codeReadTool));
}

/** Name a dinopowers wrapper ships under outside Claude Code, clear of the superpowers skill it wraps. */
export const WRAPPER_PREFIX = "dino-";

/** Mention of the shipped wrapper (`dinopowers:<s>` → `dino-<s>`) or of the superpowers skill itself. */
function wrapperMentions(md: string, dialect: HarnessDialect): string {
  const listed = dialect.listsQualifiedSkills ? /(?![A-Za-z0-9-]*`?\s+is\s+in\s+your\s+skills\s+list)/.source : "";
  const target = (plugin: string, name: string): string =>
    dialect.skillMention(plugin === "dinopowers" ? `${WRAPPER_PREFIX}${name}` : name);
  return md
    .replace(
      /\bSkill\(\s*(?:skill:\s*)?"?(dinopowers|superpowers):([A-Za-z0-9-]+)"?[^)]*\)/g,
      (_, plugin: string, name: string) => target(plugin, name),
    )
    .replace(
      new RegExp(String.raw`(?<![\w/])\/?(dinopowers|superpowers):${listed}([A-Za-z0-9-]+)`, "g"),
      (_, plugin: string, name: string) => target(plugin, name),
    );
}

export interface SkillOptions {
  /** Every skill the package ships — only these become mentions. */
  skillNames: ReadonlySet<string>;
  /** Folder name; used when the frontmatter has no `name`. */
  name?: string;
  /** Overrides the source description (e.g. a short one for an internal skill). */
  description?: string;
  /** Text of a dinopowers wrapper: wrapper and superpowers references become mentions (`toHarnessText` rule 5). */
  wrappers?: boolean;
}

/**
 * A Claude Code SKILL.md as another harness's SKILL.md: frontmatter reduced to
 * `name` + `description` (description falls back to the body's first sentence),
 * description and body through `toHarnessText`.
 */
export function toHarnessSkill(md: string, dialect: HarnessDialect, options: SkillOptions): string {
  const { fields, body } = parseFrontmatter(md);
  const name = fields.name || options.name;
  if (!name) throw new Error("skill has no name in frontmatter and none was passed");
  const description = options.description ?? (fields.description || firstSentence(body));
  return (
    renderFrontmatter(name, toHarnessText(description, dialect, options.skillNames, options.wrappers)) +
    toHarnessText(body, dialect, options.skillNames, options.wrappers)
  );
}
