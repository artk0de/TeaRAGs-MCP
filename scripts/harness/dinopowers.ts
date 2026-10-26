/**
 * The dinopowers package shared by every non-Claude harness: wrapper skills
 * renamed `dino-<name>` (clear of the superpowers skills they wrap), wrapper and
 * superpowers references as harness mentions, plus the routing tables the
 * Claude Code hooks inject, rendered in the harness's mention syntax.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { DINOPOWERS_NAME, DINOPOWERS_SRC, linkedPluginFiles, readSkills, selectSkills, walk } from "./package.js";
import { parseFrontmatter, WRAPPER_PREFIX, type SkillOptions } from "./transform.js";

export interface DinopowersRender {
  /** `dinopowers/<path>` → content: skills and the plugin files they link to. */
  files: Map<string, string>;
  /** Shipped skills as the harness lists them. */
  skills: { name: string; description: string }[];
}

export interface DinopowersDialect {
  /** A source SKILL.md in the harness dialect. */
  skill: (md: string, options: SkillOptions) => string;
  /** Any other Markdown in the harness dialect, wrapper references as mentions. */
  text: (md: string, skillNames: ReadonlySet<string>) => string;
  /** Package path of a plugin file (a harness may move folders). */
  place?: (path: string) => string;
}

/** Shipped wrapper names (`dino-<name>`) of the dinopowers source. */
export function wrapperNames(root: string): string[] {
  return selectSkills(readSkills(join(root, DINOPOWERS_SRC))).map(({ skill }) => `${WRAPPER_PREFIX}${skill.name}`);
}

/**
 * Wrapper skills and linked plugin files. `mentionable` = every skill a mention
 * may point at: the wrappers plus the skills of the packages shipped beside them.
 */
export function renderDinopowersSkills(
  root: string,
  dialect: DinopowersDialect,
  mentionable: ReadonlySet<string>,
): DinopowersRender {
  const pluginRoot = join(root, DINOPOWERS_SRC);
  const selected = selectSkills(readSkills(pluginRoot));
  const place = dialect.place ?? ((path: string) => path);
  const files = new Map<string, string>();
  const skills: DinopowersRender["skills"] = [];
  for (const { skill } of selected) {
    const name = `${WRAPPER_PREFIX}${skill.name}`;
    for (const file of walk(skill.dir)) {
      const rel = relative(skill.dir, file);
      const source = readFileSync(file, "utf8");
      const out =
        rel === "SKILL.md"
          ? dialect.skill(source.replace(/^name: .*$/m, `name: ${name}`), {
              skillNames: mentionable,
              name,
              wrappers: true,
            })
          : file.endsWith(".md")
            ? dialect.text(source, mentionable)
            : source;
      files.set(`${DINOPOWERS_NAME}/skills/${name}/${rel}`, out);
    }
    const { fields } = parseFrontmatter(files.get(`${DINOPOWERS_NAME}/skills/${name}/SKILL.md`) ?? "");
    skills.push({ name, description: fields.description });
  }
  for (const file of linkedPluginFiles(
    pluginRoot,
    selected.flatMap(({ skill }) => walk(skill.dir)),
  )) {
    const source = readFileSync(file, "utf8");
    const out = file.endsWith(".md") ? dialect.text(source, mentionable) : source;
    files.set(`${DINOPOWERS_NAME}/${place(relative(pluginRoot, file))}`, out);
  }
  return { files, skills };
}

/**
 * The text a dinopowers Claude Code hook script injects: the double-quoted value
 * of `<variable>="…"` in `plugins/dinopowers/scripts/<script>`, unescaped, trimmed.
 */
export function hookContext(root: string, script: string, variable: string): string {
  const source = readFileSync(join(root, DINOPOWERS_SRC, "scripts", script), "utf8");
  const match = new RegExp(`^${variable}="((?:[^"\\\\]|\\\\.)*)"`, "m").exec(source);
  if (!match) throw new Error(`${script}: no ${variable}="…" assignment`);
  return match[1].replace(/\\(["\\$`])/g, "$1").trim();
}

/** Main-session routing (SessionStart) and subagent routing (SubagentStart) tables. */
export const ROUTING_HOOKS = {
  mainSession: { script: "inject-main-session-routing.sh", variable: "CONTEXT", text: "main-session-routing.txt" },
  subagent: { script: "inject-wrapper-routing.sh", variable: "ROUTING", text: "wrapper-routing.txt" },
} as const;
