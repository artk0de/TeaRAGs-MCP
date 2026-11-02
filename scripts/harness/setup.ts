/**
 * The tea-rags-setup package shared by every non-Claude harness: the install and
 * tune skills in the harness dialect, plus the Node helper scripts they run
 * (`scripts/*.mjs`), shipped verbatim. The manifest is harness-specific and
 * written by the caller.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { readSkills, selectSkills, SETUP_NAME, SETUP_SRC, walk } from "./package.js";
import type { SkillOptions } from "./transform.js";

export interface SetupDialect {
  /** A source SKILL.md in the harness dialect. */
  skill: (md: string, options: SkillOptions) => string;
  /** Any other Markdown in the harness dialect. */
  text: (md: string, skillNames: ReadonlySet<string>) => string;
}

/**
 * `tea-rags-setup/<path>` → content: every shipped skill and every helper script.
 * `mentionable` = skills a mention may point at besides the setup skills themselves.
 */
export function renderSetupPackage(
  root: string,
  dialect: SetupDialect,
  mentionable: ReadonlySet<string>,
): Map<string, string> {
  const pluginRoot = join(root, SETUP_SRC);
  const selected = selectSkills(readSkills(pluginRoot));
  const skillNames = new Set([...mentionable, ...selected.map(({ skill }) => skill.name)]);
  const files = new Map<string, string>();
  for (const { skill } of selected) {
    for (const file of walk(skill.dir)) {
      const rel = relative(skill.dir, file);
      const source = readFileSync(file, "utf8");
      const out =
        rel === "SKILL.md"
          ? dialect.skill(source, { skillNames, name: skill.name })
          : file.endsWith(".md")
            ? dialect.text(source, skillNames)
            : source;
      files.set(`${SETUP_NAME}/skills/${skill.name}/${rel}`, out);
    }
  }
  for (const file of walk(join(pluginRoot, "scripts"))) {
    files.set(`${SETUP_NAME}/${relative(pluginRoot, file)}`, readFileSync(file, "utf8"));
  }
  return files;
}
