import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CORE_RULE_MAX_CHARS,
  CURSOR_HARNESS_DIR,
  renderCursorHarness,
  toCursorSkill,
} from "../../scripts/gen-harness-cursor.js";
import { parseFrontmatter } from "../../scripts/harness/transform.js";

const ROOT = resolve(__dirname, "../..");

/** Manifest fields the Cursor plugin reference documents (facts §B.1). */
const MANIFEST_FIELDS = new Set([
  "name",
  "description",
  "version",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "logo",
  "rules",
  "agents",
  "skills",
  "commands",
  "hooks",
  "mcpServers",
  "variables",
]);

/** Hook events Cursor documents (facts §B.3). */
const HOOK_EVENTS = new Set([
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "workspaceOpen",
]);

const FIXTURE = `---
name: filter-building
description: Build a raw filter. Use tea-rags:explore first.
user-invocable: true
---

# Filter Building

ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/filters")
Chain Skill(tea-rags:explore), then \`tea-rags:test-first\`.
Run \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh in "$CLAUDE_PROJECT_DIR".
`;

const KNOWN = new Set(["explore", "filter-building", "test-first"]);

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

describe("toCursorSkill", () => {
  const out = toCursorSkill(FIXTURE, { skillNames: KNOWN });

  it("keeps only name and description and mentions skills as slash commands", () => {
    const { fields } = parseFrontmatter(out);

    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.description).toBe("Build a raw filter. Use /explore first.");
    expect(out).toContain("Chain /explore, then `/test-first`.");
  });

  it("names Cursor's resource tool and the terminal fallback under the title", () => {
    expect(out).toContain('FetchMcpResource(server: "tea-rags", uri: "tea-rags://schema/filters")');
    expect(out).toMatch(/^# Filter Building\n\n.*tea-rags resource "<uri>" --path "\$PWD"/m);
  });

  it("adds no fallback note to a skill that names no tea-rags:// URI", () => {
    const plain = toCursorSkill("---\nname: explore\ndescription: X.\n---\n\n# Explore\n\nBody.\n", {
      skillNames: KNOWN,
    });

    expect(plain).not.toContain("tea-rags resource");
  });

  it("replaces Claude Code environment variables with Cursor's", () => {
    expect(out).toContain(`Run \${CURSOR_PLUGIN_ROOT}/scripts/x.sh in "$PWD".`);
    expect(out).not.toContain("CLAUDE_");
  });
});

describe("renderCursorHarness", () => {
  let rendered: Map<string, string>;

  beforeAll(async () => {
    rendered = await renderCursorHarness(ROOT);
  });

  it("matches the committed package (run `npm run gen:harness-cursor` if this fails)", () => {
    const dir = join(ROOT, CURSOR_HARNESS_DIR);
    const onDisk = listFiles(dir)
      .map((file) => relative(dir, file))
      .sort();

    expect(onDisk).toEqual([...rendered.keys()].sort());
    for (const [path, content] of rendered) {
      expect(readFileSync(join(dir, path), "utf8"), path).toBe(content);
    }
  });

  it("renders byte-identically twice", async () => {
    expect(await renderCursorHarness(ROOT)).toEqual(rendered);
  });

  it("emits parseable JSON everywhere", () => {
    const jsonFiles = [...rendered].filter(([path]) => path.endsWith(".json"));

    expect(jsonFiles.length).toBeGreaterThanOrEqual(3);
    for (const [path, content] of jsonFiles) {
      expect(() => JSON.parse(content), path).not.toThrow();
    }
  });

  it("writes a manifest with documented fields only", () => {
    const manifest = JSON.parse(rendered.get("tea-rags/.cursor-plugin/plugin.json") ?? "");

    expect(Object.keys(manifest).filter((key) => !MANIFEST_FIELDS.has(key))).toEqual([]);
    expect(manifest.name).toBe("tea-rags");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("registers only documented hook events and injects at sessionStart only", () => {
    const hooks = JSON.parse(rendered.get("tea-rags/hooks/hooks.json") ?? "");

    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).filter((event) => !HOOK_EVENTS.has(event))).toEqual([]);
    expect(Object.keys(hooks.hooks)).toEqual(["sessionStart"]);
    const [{ command }] = hooks.hooks.sessionStart;
    expect(command).toBe(`\${CURSOR_PLUGIN_ROOT}/scripts/session-start.sh`);
    expect(rendered.has("tea-rags/scripts/session-start.sh")).toBe(true);
  });

  it("ships a sessionStart script that answers with additional_context", () => {
    const script = rendered.get("tea-rags/scripts/session-start.sh") ?? "";

    expect(script).toContain("tea-rags prime");
    expect(script).toContain("additional_context");
    expect(script).not.toContain("CLAUDE_");
  });

  it("declares the MCP server with an explicit type", () => {
    const mcp = JSON.parse(rendered.get("tea-rags/mcp.json") ?? "");

    expect(mcp.mcpServers["tea-rags"]).toEqual({ type: "stdio", command: "tea-rags", args: ["server"] });
  });

  it("ships skills whose name equals the folder, with no dinopowers wrapper", () => {
    const skills = [...rendered].filter(([path]) => /^tea-rags\/skills\/[^/]+\/SKILL\.md$/.test(path));

    expect(skills.length).toBeGreaterThan(0);
    for (const [path, content] of skills) {
      const { fields } = parseFrontmatter(content);
      expect(Object.keys(fields), path).toEqual(["name", "description"]);
      expect(path).toBe(`tea-rags/skills/${fields.name}/SKILL.md`);
    }
    expect(skills.map(([path]) => path).join()).not.toMatch(/dinopowers|writing-plans|executing-plans/);
  });

  it("gives the terminal fallback wherever a shipped Markdown file names a tea-rags:// URI", () => {
    const missing = [...rendered]
      .filter(([path, content]) => /\.mdc?$/.test(path) && path.startsWith("tea-rags/") && content.includes("tea-rags://"))
      .filter(([, content]) => !content.includes('tea-rags resource "<uri>" --path "$PWD"'))
      .map(([path]) => path);

    expect(missing).toEqual([]);
  });

  it("keeps every emitted rule alwaysApply and within the core size cap", () => {
    for (const [path, content] of rendered) {
      if (!path.endsWith(".mdc")) continue;
      expect(parseFrontmatter(content).fields.alwaysApply, path).toBe("true");
      expect(content.length, path).toBeLessThanOrEqual(CORE_RULE_MAX_CHARS);
    }
  });

  it("keeps rules/ for rule files only and resolves every relative link", () => {
    const rules = [...rendered.keys()].filter((path) => path.startsWith("tea-rags/rules/"));
    expect(rules.filter((path) => !/^tea-rags\/rules\/[^/]+\.mdc$/.test(path))).toEqual([]);

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
});

describe("renderCursorHarness — core rule", () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "harness-cursor-"));
    cpSync(join(ROOT, ".claude-plugin/tea-rags"), join(fixtureRoot, ".claude-plugin/tea-rags"), { recursive: true });
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("emits no core rule and says so in the README while rules/core.md is absent", async () => {
    rmSync(join(fixtureRoot, ".claude-plugin/tea-rags/rules/core.md"), { force: true });
    const out = await renderCursorHarness(fixtureRoot);

    expect([...out.keys()].some((path) => path.endsWith(".mdc"))).toBe(false);
    expect(out.get("README.md")).toContain("`rules/core.md` does not exist yet");
  });

  it("emits rules/core.md as an alwaysApply rule with both resource routes", async () => {
    writeFileSync(
      join(fixtureRoot, ".claude-plugin/tea-rags/rules/core.md"),
      "# tea-rags core\n\nUse mcp__tea-rags__find_symbol. After a search read tea-rags://guide/navigation.\n",
    );
    const out = await renderCursorHarness(fixtureRoot);
    const rule = out.get("tea-rags/rules/tea-rags-core.mdc") ?? "";
    const { fields, body } = parseFrontmatter(rule);

    expect(fields.alwaysApply).toBe("true");
    expect(fields.description).not.toBe("");
    expect(body).toContain("Use find_symbol.");
    expect(body).toContain("tea-rags://guide/navigation");
    expect(body).toContain('tea-rags resource "<uri>" --path "$PWD"');
    expect(rule.length).toBeLessThanOrEqual(CORE_RULE_MAX_CHARS);
    expect(out.get("README.md")).not.toContain("`rules/core.md` does not exist yet");
  });
});
