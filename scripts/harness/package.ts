/**
 * Harness-neutral package plumbing: reads the plugin sources under `plugins/`
 * (written in the Claude Code dialect), picks the skills a harness package ships,
 * and writes a rendered package. Shared by every `scripts/gen-harness-*.ts`.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { format, resolveConfig } from "prettier";

import { firstSentence, parseFrontmatter } from "./transform.js";

/** Folder holding every plugin source, relative to the repository root. */
export const PLUGINS_DIR = "plugins";
/** Plugin source folder, relative to the repository root. */
export const PLUGIN_SRC = `${PLUGINS_DIR}/tea-rags`;
export const PLUGIN_NAME = "tea-rags";
/** The wrapper plugin, shipped as its own package next to tea-rags in every harness marketplace. */
export const DINOPOWERS_NAME = "dinopowers";
export const DINOPOWERS_SRC = `${PLUGINS_DIR}/${DINOPOWERS_NAME}`;
/** Package folders every harness renders, in marketplace order. */
export const HARNESS_PACKAGES: readonly string[] = [PLUGIN_NAME, DINOPOWERS_NAME];

/**
 * Hook scripts every harness ships verbatim from `plugins/tea-rags/scripts/` (bd tea-rags-mcp-nknkg.2):
 * one implementation for Claude Code, Codex and Cursor, the harness picked by `--harness`.
 * `turn-routing.sh` re-injects the routing lines each user turn; `search-drift.sh` denies once after
 * a streak of text searches / indexed-code reads with no tea-rags call.
 */
export const SHARED_HOOK_SCRIPTS = ["turn-routing.sh", "search-drift.sh"] as const;

/** Single source of the per-turn routing lines (fenced block under "## The block to inject"). */
export const TURN_ROUTING_SOURCE = "rules/references/turn-routing.md";

export interface SourceSkill {
  name: string;
  dir: string;
  internal: boolean;
  fields: Record<string, string>;
  body: string;
  /** SKILL.md + every Markdown file under the skill folder, joined — reference scan. */
  text: string;
}

export interface PluginManifest {
  version: string;
  description: string;
  author?: { name: string; email?: string };
  keywords?: string[];
}

/** Every file under `dir`, sorted, depth-first. */
export function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

export function readManifest(pluginRoot: string): PluginManifest {
  return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as PluginManifest;
}

export function readSkills(pluginRoot: string): SourceSkill[] {
  const skillsDir = join(pluginRoot, "skills");
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
 * runtime. Internal skills get a short description naming their callers.
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

/** Short description of an internal skill, naming its callers in the harness's mention form. */
export function internalDescription(
  skill: SourceSkill,
  callers: string[],
  skillMention: (name: string) => string,
): string {
  const purpose = firstSentence(skill.fields.description || skill.body);
  return `Internal step invoked by ${callers.map(skillMention).join(", ")}. ${purpose}`;
}

/**
 * Plugin files outside `skills/` that shipped Markdown links to by relative path
 * (`../../repair/<family>.md` → the whole `repair/` folder), transitively.
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

/** Pretty-printed JSON with a trailing newline. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The package sorted by path, `.md` / `.json` / `.mdc` files Prettier-formatted
 * with the config that applies at their committed place, so the render is
 * byte-identical to what lint-staged would leave there.
 */
export async function formatPackage(
  root: string,
  packageDir: string,
  files: Map<string, string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.(md|mdc|json)$/.test(path)) {
      out.set(path, content);
      continue;
    }
    const filepath = join(root, packageDir, path);
    const config = await resolveConfig(filepath);
    const parser = path.endsWith(".mdc") ? { parser: "markdown" } : {};
    out.set(path, await format(content, { ...config, ...parser, filepath }));
  }
  return out;
}

/** Replace `<root>/<packageDir>` with `rendered`; shell scripts made executable. */
export function writePackage(root: string, packageDir: string, rendered: Map<string, string>): number {
  const dir = join(root, packageDir);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of rendered) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    if (path.endsWith(".sh")) chmodSync(target, 0o755);
  }
  return rendered.size;
}

/** A repository-root file (a marketplace manifest), Prettier-formatted like the committed one. */
export async function formatRootFile(root: string, path: string, content: string): Promise<string> {
  return (await formatPackage(root, ".", new Map([[path, content]]))).get(path) as string;
}

/** Write a repository-root file, creating its folder. */
export function writeRootFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}
