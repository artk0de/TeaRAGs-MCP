import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEX_HARNESS_DIR,
  renderCodexHarness,
  SKILLS_LIST_BUDGET,
  toCodexSkill,
} from "../../scripts/gen-harness-codex.js";
import { dropLoadTimeBlocks, extractInjectionBlock, parseFrontmatter } from "../../scripts/harness/transform.js";

const ROOT = resolve(__dirname, "../..");

const FIXTURE = `---
name: bug-hunt
description:
  Find source of concrete failure. Triggers on "debug X". NOT for scans — use
  tea-rags:explore.
argument-hint: [symptom]
user-invocable: true
---

# Bug Hunt

Need thresholds → read tea-rags://project/<alias>/metrics?section=thresholds
!\`tea-rags resource "tea-rags://project/x/metrics?section=thresholds" --path "$PWD" || true\`
Inline \`\` !\`tea-rags resource tea-rags://guide/filters || true\` \`\` here.
Keep \`!\`/\`?\` suffixes as written.

Read the catalog: ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/filters").
Call mcp__tea-rags__find_symbol then mcp__tea-rags__hybrid_search.
Chain Skill(tea-rags:data-driven-generation), then /tea-rags:explore, then \`tea-rags:test-first\`.
Plan via \`dinopowers:writing-plans\`.
Unknown tea-rags:setup stays; tea-rags://guide/navigation stays.

- Spawn a subagent (Agent tool) — too slow.

\`\`\`
Agent tool:
  subagent_type: general-purpose
  prompt: |
    Call mcp__tea-rags__index_codebase
\`\`\`

Ask for explicit confirmation using \`AskUserQuestion\`:
escalate: AskUserQuestion (subagent → hand back).
Run \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh in "$CLAUDE_PROJECT_DIR".
`;

const KNOWN = new Set(["bug-hunt", "data-driven-generation", "explore", "test-first"]);

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

describe("parseFrontmatter", () => {
  it("joins folded continuation lines and keeps the body", () => {
    const { fields, body } = parseFrontmatter(FIXTURE);

    expect(fields.name).toBe("bug-hunt");
    expect(fields.description).toBe(
      'Find source of concrete failure. Triggers on "debug X". NOT for scans — use tea-rags:explore.',
    );
    expect(fields["user-invocable"]).toBe("true");
    expect(body.startsWith("\n# Bug Hunt")).toBe(true);
  });

  it("unquotes single- and double-quoted folded values", () => {
    const { fields } = parseFrontmatter(`---\nname: "a"\ndescription:\n  'It''s a\n  folded value'\n---\n`);

    expect(fields).toEqual({ name: "a", description: "It's a folded value" });
  });

  it("returns empty fields for a file without frontmatter", () => {
    expect(parseFrontmatter("# Title\n").fields).toEqual({});
  });
});

describe("dropLoadTimeBlocks", () => {
  it("drops a block standing alone on its line and keeps the model-read line beside it", () => {
    const out = dropLoadTimeBlocks("Need X → read tea-rags://guide/x\n!`tea-rags resource tea-rags://guide/x`\nnext\n");

    expect(out).toBe("Need X → read tea-rags://guide/x\nnext\n");
  });

  it("drops an inline block with its double-backtick wrapper", () => {
    expect(dropLoadTimeBlocks("Inline `` !`cmd || true` `` here.")).toBe("Inline here.");
  });

  it("leaves a backtick-preceded `!` alone", () => {
    expect(dropLoadTimeBlocks("Keep `!`/`?` suffixes.")).toBe("Keep `!`/`?` suffixes.");
  });
});

describe("toCodexSkill", () => {
  const out = toCodexSkill(FIXTURE, { skillNames: KNOWN });

  it("keeps only name and description in the frontmatter", () => {
    const { fields } = parseFrontmatter(out);

    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.description).toBe(
      'Find source of concrete failure. Triggers on "debug X". NOT for scans — use $explore.',
    );
  });

  it("drops load-time blocks", () => {
    expect(out).not.toContain("!`tea-rags resource");
    expect(out).toContain("Need thresholds → read tea-rags://project/<alias>/metrics?section=thresholds");
    expect(out).toContain("Keep `!`/`?` suffixes as written.");
  });

  it("rewrites resource and MCP tool names to Codex's", () => {
    expect(out).toContain('read_mcp_resource(server: "tea-rags", uri: "tea-rags://guide/filters")');
    expect(out).toContain("Call find_symbol then hybrid_search.");
    expect(out).not.toContain("mcp__tea-rags__");
  });

  it("turns skill references into $-mentions", () => {
    expect(out).toContain("Chain $data-driven-generation, then $explore, then `$test-first`.");
    expect(out).toContain("Plan via `writing-plans`.");
    expect(out).toContain("Unknown tea-rags:setup stays; tea-rags://guide/navigation stays.");
  });

  it("rewrites Agent-tool passages to spawning a subagent", () => {
    expect(out).toContain("- Spawn a subagent — too slow.");
    expect(out).toContain("Spawn a subagent:\n  prompt: |\n    Call index_codebase");
    expect(out).not.toContain("subagent_type");
  });

  it("rewrites AskUserQuestion to asking the user", () => {
    expect(out).toContain("Ask for explicit confirmation by asking the user:");
    expect(out).toContain("escalate: ask the user (subagent → hand back).");
  });

  it("replaces Claude Code environment variables", () => {
    expect(out).toContain(`Run \${PLUGIN_ROOT}/scripts/x.sh in "$PWD".`);
  });

  it("falls back to the folder name and a body-derived description", () => {
    const bare = toCodexSkill("---\nuser-invocable: false\n---\n\n# Scan\n\nInternal scan step. More.\n", {
      skillNames: KNOWN,
      name: "refactoring-scan",
    });

    expect(parseFrontmatter(bare).fields).toEqual({
      name: "refactoring-scan",
      description: "Internal scan step.",
    });
  });
});

describe("extractInjectionBlock", () => {
  it("returns the first fenced block under the inject heading", () => {
    const md =
      "# X\n```\nnot this\n```\n## The block to inject\n\nprose\n\n```\nline 1\nline 2\n```\n```\nnor this\n```\n";

    expect(extractInjectionBlock(md)).toBe("line 1\nline 2");
  });
});

describe("renderCodexHarness", () => {
  it("matches the committed package (run `npm run gen:harness-codex` if this fails)", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const dir = join(ROOT, CODEX_HARNESS_DIR);
    const onDisk = listFiles(dir)
      .map((file) => relative(dir, file))
      .sort();

    expect(onDisk).toEqual([...rendered.keys()].sort());
    for (const [path, content] of rendered) {
      expect(readFileSync(join(dir, path), "utf8"), path).toBe(content);
    }
  });

  it("emits parseable JSON with the plugin manifest paths", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const manifest = JSON.parse(rendered.get("tea-rags/.codex-plugin/plugin.json") ?? "");

    expect(manifest).toMatchObject({
      name: "tea-rags",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
    });
    expect(JSON.parse(rendered.get("tea-rags/.mcp.json") ?? "").mcpServers["tea-rags"]).toMatchObject({
      command: "tea-rags",
      args: ["server"],
    });
    const { hooks } = JSON.parse(rendered.get("tea-rags/hooks/hooks.json") ?? "");
    expect(Object.keys(hooks).sort()).toEqual(["SessionStart", "SubagentStart"]);
    expect(JSON.stringify(hooks)).not.toContain("CLAUDE_");
    const marketplace = JSON.parse(rendered.get(".agents/plugins/marketplace.json") ?? "");
    expect(marketplace.plugins[0].source).toEqual({ source: "local", path: "./tea-rags" });
  });

  it("ships no dinopowers skill and keeps the skills list within budget", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const skills = [...rendered].filter(([path]) => /^tea-rags\/skills\/[^/]+\/SKILL\.md$/.test(path));
    let total = 0;
    for (const [path, content] of skills) {
      const { fields } = parseFrontmatter(content);
      expect(Object.keys(fields), path).toEqual(["name", "description"]);
      expect(path).toBe(`tea-rags/skills/${fields.name}/SKILL.md`);
      total += fields.name.length + fields.description.length;
    }

    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map(([path]) => path).join()).not.toMatch(/dinopowers|writing-plans|executing-plans/);
    expect(total).toBeLessThanOrEqual(SKILLS_LIST_BUDGET);
  });

  it("ships every plugin file a shipped skill links to by relative path", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const missing: string[] = [];
    for (const [path, content] of rendered) {
      if (!path.startsWith("tea-rags/skills/") || !path.endsWith(".md")) continue;
      for (const [link] of content.matchAll(/(?:\.\.\/)+[\w./-]+/g)) {
        const target = join(dirname(path), link).replace(/\/$/, "");
        const shipped = [...rendered.keys()].some((key) => key === target || key.startsWith(`${target}/`));
        if (!shipped) missing.push(`${path} → ${link}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("ships a subagent block script that does not depend on Claude Code variables", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const script = rendered.get("tea-rags/scripts/subagent-block.sh") ?? "";

    expect(script).toContain("additionalContext");
    expect(script).not.toContain("CLAUDE_");
    expect(rendered.get("tea-rags/scripts/subagent-block.txt")).not.toContain("mcp__tea-rags__");
  });
});
