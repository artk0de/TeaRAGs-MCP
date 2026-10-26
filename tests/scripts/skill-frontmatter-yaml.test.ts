import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseFrontmatter } from "../../scripts/harness/transform.js";

// Claude Code drops a skill whose frontmatter fails strict YAML from the
// model's skill listing (bd tea-rags-mcp-zes6j): the skill stays invocable by
// name but routing never picks it. Every source SKILL.md must parse strictly,
// and the strict and the lenient (generator) readers must agree on the text.

const ROOT = join(import.meta.dirname, "../..");
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function sourceSkills(): string[] {
  const plugins = join(ROOT, "plugins");
  return readdirSync(plugins).flatMap((plugin) => {
    const skills = join(plugins, plugin, "skills");
    if (!existsSync(skills)) return [];
    return readdirSync(skills)
      .map((skill) => join("plugins", plugin, "skills", skill, "SKILL.md"))
      .filter((path) => existsSync(join(ROOT, path)));
  });
}

describe("plugins/**/SKILL.md frontmatter", () => {
  const skills = sourceSkills();

  it("finds the source skills", () => {
    expect(skills.length).toBeGreaterThan(20);
  });

  // Internal strategies a skill reads by path (no routing) carry no description.
  it.each(skills)("%s parses as strict YAML; a description, when present, is non-empty text", (path) => {
    const frontmatter = FRONTMATTER.exec(readFileSync(join(ROOT, path), "utf8"))?.[1];
    expect(frontmatter, "frontmatter block").toBeDefined();
    const fields = parse(frontmatter ?? "") as Record<string, unknown>;
    if ("description" in fields) {
      expect(typeof fields.description).toBe("string");
      expect((fields.description as string).length).toBeGreaterThan(0);
    }
  });

  it.each(skills)("%s: strict and lenient readers agree on description and codex-description", (path) => {
    const md = readFileSync(join(ROOT, path), "utf8");
    const strict = parse(FRONTMATTER.exec(md)?.[1] ?? "") as Record<string, unknown>;
    const lenient = parseFrontmatter(md).fields;
    expect(lenient.description).toBe(strict.description);
    expect(lenient["codex-description"]).toBe(strict["codex-description"]);
  });
});
