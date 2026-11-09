import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  renderZcodeHarness,
  toZcodeSkill,
  writeZcodeHarness,
  ZCODE_HARNESS_DIR,
  ZCODE_HOOK_EVENTS,
  ZCODE_MARKETPLACE_PATH,
} from "../../scripts/gen-harness-zcode.js";
import { HARNESS_PACKAGES, ICON_ASSETS_DIR, PLUGIN_SRC, PLUGINS_DIR } from "../../scripts/harness/package.js";
import { parseFrontmatter } from "../../scripts/harness/transform.js";

const ROOT = resolve(__dirname, "../..");

/** Manifest fields ZCode's plugin reference documents (zcode-guide diagnosing-plugins §2). */
const MANIFEST_FIELDS = new Set([
  "name",
  "version",
  "description",
  "commands",
  "skills",
  "hooks",
  "mcpServers",
  "userConfig",
  "author",
  "keywords",
  "license",
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

const CODE_SEARCH_SOURCE = `---
name: bug-hunt
description: Find source of concrete failure.
---

TODO markers → default code search tool, never tea-rags.
Print \`default code search tool "<phrase>" <dir> (literal) → find_symbol\`.
Wrapped: the default
  code search tool (not a tea-rags tool).
Never read with the default code read tool or
  the default code read tool again.
`;
const KNOWN = new Set(["explore", "filter-building", "test-first"]);

describe("toZcodeSkill", () => {
  const out = toZcodeSkill(FIXTURE, { skillNames: KNOWN });

  it("names the Bash rg channel for the default code search tool, folding the literal", () => {
    const text = toZcodeSkill(CODE_SEARCH_SOURCE, { skillNames: KNOWN });

    expect(text).toContain("TODO markers → Bash rg, never tea-rags.");
    expect(text).toContain('Print `Bash rg "<phrase>" <dir> (literal) → find_symbol`.');
    expect(text).toContain("Wrapped: Bash rg (not a tea-rags tool).");
    expect(text).toContain("Never read with Read tool or\n  Read tool again.");
    expect(text).not.toMatch(/default\s+code\s+(?:search|read)\s+tool/i);
  });

  it("keeps only name and description and mentions skills qualified (plugin:skill)", () => {
    const { fields } = parseFrontmatter(out);

    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.description).toBe("Build a raw filter. Use tea-rags:explore first.");
    expect(out).toContain("Chain tea-rags:explore, then `tea-rags:test-first`.");
  });

  it("keeps the full description and drops codex-description", () => {
    const withCodex = toZcodeSkill(
      "---\nname: explore\ndescription: Full text.\ncodex-description:\n  Short.\n---\n\n# Explore\n\nBody.\n",
      { skillNames: KNOWN },
    );
    const { fields } = parseFrontmatter(withCodex);

    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.description).toBe("Full text.");
    expect(withCodex).not.toContain("Short.");
  });

  it("routes resource reads to the CLI (ZCode has no model-side resource tool)", () => {
    expect(out).toContain('`tea-rags resource <uri>` (Bash)(server: "tea-rags", uri: "tea-rags://schema/filters")');
  });

  it("keeps CLAUDE_PLUGIN_ROOT (ZCode expands it) and replaces CLAUDE_PROJECT_DIR with $PWD", () => {
    expect(out).toContain(`Run \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh in "$PWD".`);
    expect(out).not.toContain("CLAUDE_PROJECT_DIR");
  });
});

describe("renderZcodeHarness", () => {
  let rendered: Map<string, string>;

  beforeAll(async () => {
    rendered = await renderZcodeHarness(ROOT);
  });

  it("renders byte-identically twice", async () => {
    expect(await renderZcodeHarness(ROOT)).toEqual(rendered);
  });

  it("emits parseable JSON everywhere", () => {
    const jsonFiles = [...rendered].filter(([path]) => path.endsWith(".json"));

    expect(jsonFiles.length).toBeGreaterThanOrEqual(3);
    for (const [path, content] of jsonFiles) {
      expect(() => JSON.parse(content), path).not.toThrow();
    }
  });

  it("writes manifests with documented fields only, names matching ZCode's pattern", () => {
    for (const path of [...rendered].filter(([p]) => p.endsWith(".zcode-plugin/plugin.json")).map(([p]) => p)) {
      const manifest = JSON.parse(rendered.get(path) ?? "");

      expect(
        Object.keys(manifest).filter((key) => !MANIFEST_FIELDS.has(key)),
        path,
      ).toEqual([]);
      expect(manifest.name, path).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
      expect(manifest.version, path).toMatch(/^\d+\.\d+\.\d+/);
    }
    const manifest = JSON.parse(rendered.get("tea-rags/.zcode-plugin/plugin.json") ?? "");

    expect(manifest).toMatchObject({
      name: "tea-rags",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
    });
  });

  it("ships the marketplace inside the package, sources resolving to the package folders", () => {
    const marketplace = JSON.parse(rendered.get("marketplace.json") ?? "");

    expect(marketplace.name).toBe("tea-rags");
    expect(marketplace.plugins.map((plugin: { name: string }) => plugin.name)).toEqual([
      "tea-rags",
      "dinopowers",
      "tea-rags-setup",
    ]);
    for (const plugin of marketplace.plugins) {
      expect(rendered.has(`${plugin.source.replace(/^\.\//, "")}/.zcode-plugin/plugin.json`), plugin.source).toBe(true);
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
      // Local-directory marketplace: the icon ships next to the plugin (official CDN uses HTTPS URLs).
      expect(plugin.icon, plugin.name).toBe(`./${plugin.name}/icon.png`);
    }
  });

  it("registers only ZCode's seven events — no SubagentStart", () => {
    const { hooks } = JSON.parse(rendered.get("tea-rags/hooks/hooks.json") ?? "");

    expect(
      Object.keys(hooks).filter((event: string) => !(ZCODE_HOOK_EVENTS as readonly string[]).includes(event)),
    ).toEqual([]);
    expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
    expect(hooks.SubagentStart).toBeUndefined();
  });

  it("wires every hook command to a shipped script, timeouts in seconds", () => {
    const { hooks } = JSON.parse(rendered.get("tea-rags/hooks/hooks.json") ?? "") as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number; type: string }[] }[]>;
    };

    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe("command");
          expect(hook.timeout).toBeGreaterThan(0);
          const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w.-]+)/.exec(hook.command)?.[1];
          expect(script, hook.command).toBeTruthy();
          expect(rendered.has(`tea-rags/scripts/${script}`), hook.command).toBe(true);
        }
      }
    }
    // The subagent block rides the Agent dispatch: ZCode has no SubagentStart event.
    const agentEntry = hooks.PreToolUse.find((entry) => entry.matcher === "^(Agent|Task)$");

    expect(agentEntry?.hooks[0].command).toContain("subagent-context.sh");
    // The drift deny rides PreToolUse on the Bash (and Grep, when configured) channel.
    expect(hooks.PreToolUse.find((entry) => entry.matcher === "Grep|Bash")).toBeTruthy();
  });

  it("ships the Claude plugin's hook scripts verbatim", () => {
    for (const script of [
      "turn-routing.sh",
      "search-drift.sh",
      "reread-ledger.mjs",
      "standard-zone.ere",
      "inject-rules.sh",
      "check-build-fresh.sh",
      "cleanup-worktree-clone.sh",
    ]) {
      expect(rendered.get(`tea-rags/scripts/${script}`), script).toBe(
        readFileSync(join(ROOT, PLUGIN_SRC, "scripts", script), "utf8"),
      );
    }
  });

  it("ships the core rules the SessionStart hook injects, in ZCode's dialect", () => {
    const core = rendered.get("tea-rags/rules/core.md") ?? "";

    expect(core.length).toBeGreaterThan(4000);
    expect(core).toContain("# tea-rags core");
    expect(core).not.toContain("SubagentStart");
    expect(core).toContain("the subagent dispatch hook");
    expect(core).toContain("Bash rg");
    expect(core).not.toMatch(/default code (search|read) tool/);
  });

  it("ships the subagent block and turn routing in ZCode's dialect", () => {
    const block = rendered.get("tea-rags/scripts/subagent-block.txt") ?? "";
    const routing = rendered.get("tea-rags/scripts/turn-routing.txt") ?? "";

    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toContain("mcp__tea-rags__");
    expect(block).toContain("Read tool");
    expect(block).toContain("Bash rg");
    expect(routing).toContain("tea-rags routing (this turn):");
    expect(routing).toContain("Bash rg");
    expect(routing.length).toBeLessThanOrEqual(400);
  });

  it("declares a stdio MCP server for the plugin", () => {
    expect(JSON.parse(rendered.get("tea-rags/.mcp.json") ?? "")).toEqual({
      mcpServers: { "tea-rags": { type: "stdio", command: "tea-rags", args: ["server"] } },
    });
  });

  it("renames dinopowers wrappers dino-<s> and wires routing on SessionStart and Agent dispatch", () => {
    const { hooks } = JSON.parse(rendered.get("dinopowers/hooks/hooks.json") ?? "");
    const wrapperSkills = [...rendered.keys()].filter((path) => /^dinopowers\/skills\/[^/]+\/SKILL.md$/.test(path));

    expect(wrapperSkills.length).toBeGreaterThan(5);
    expect(wrapperSkills.every((path) => path.includes("/dino-"))).toBe(true);
    expect(Object.keys(hooks)).toEqual(["SessionStart", "PreToolUse"]);
    expect(hooks.PreToolUse[0].matcher).toBe("^(Agent|Task)$");
    expect(rendered.get("dinopowers/scripts/main-session-routing.txt")).toContain("dino-brainstorming");
    expect(rendered.has("dinopowers/scripts/wrapper-routing.txt")).toBe(true);
  });

  it("ships every referenced skill folder completely", () => {
    const shipped = new Set(
      [...rendered.keys()].filter((path) => /^tea-rags\/skills\/[^/]+\//.test(path)).map((path) => path.split("/")[2]),
    );

    expect(shipped.size).toBeGreaterThan(5);
    for (const name of shipped) {
      expect(rendered.get(`tea-rags/skills/${name}/SKILL.md`), name).toBeTruthy();
    }
  });

  // ZCode's frontmatter reader takes flat `key: value` lines and `>` / `|`
  // block scalars only [S:zcode-guide diagnosing-skills §2]; a long quoted
  // description that Prettier reflows onto indented continuation lines reads
  // as a MISSING description there and the whole skill is dropped from the
  // session (observed 2026-11-09: no tea-rags:* / dinopowers:* skill loaded).
  it("ships every SKILL.md loadable by ZCode's flat frontmatter reader", () => {
    const skills = [...rendered].filter(([path]) => /\/skills\/[^/]+\/SKILL\.md$/.test(path));

    expect(skills.length).toBeGreaterThan(20);
    for (const [path, content] of skills) {
      const block = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
      expect(block, `${path}: frontmatter block`).toBeDefined();
      const fields = parseYaml(block ?? "") as Record<string, unknown>;

      expect(typeof fields.description, `${path}: description`).toBe("string");
      expect((fields.description as string).length, `${path}: description not empty`).toBeGreaterThan(0);
      expect((fields.description as string).length, `${path}: within ZCode's 1024-char limit`).toBeLessThanOrEqual(
        1024,
      );

      // The zcode reader: a key line carries its value — flat text or a `>`/`|`
      // block indicator; `key:` with the value reflowed onto indented lines
      // (Prettier's wrap of a long quoted scalar) reads as missing → dropped.
      for (const line of (block ?? "").split("\n")) {
        if (!/^[A-Za-z][\w-]*:/.test(line)) continue;
        const value = line.replace(/^[A-Za-z][\w-]*:\s*/, "");
        expect(value, `${path}: "${line}" — value must sit on the key line (flat or > / | indicator)`).not.toBe("");
      }

      // Strict YAML and the generator's lenient reader must agree on the text.
      expect(parseFrontmatter(content).fields.description).toBe(fields.description as string);
    }
  });
});

describe("writeZcodeHarness icon assets", () => {
  it("ships <plugin>/icon.png from assets/icons with the marketplace icon paths resolving", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-zcode-icons-"));
    cpSync(join(ROOT, PLUGINS_DIR), join(root, PLUGINS_DIR), { recursive: true });
    cpSync(join(ROOT, ICON_ASSETS_DIR), join(root, ICON_ASSETS_DIR), { recursive: true });
    try {
      await writeZcodeHarness(root);
      const marketplace = JSON.parse(readFileSync(join(root, ZCODE_HARNESS_DIR, ZCODE_MARKETPLACE_PATH), "utf8"));
      for (const plugin of marketplace.plugins) {
        const icon = join(root, ZCODE_HARNESS_DIR, plugin.icon.replace(/^\.\//, ""));
        expect(existsSync(icon), plugin.icon).toBe(true);
        expect(readFileSync(icon), plugin.name).toEqual(
          readFileSync(join(root, ICON_ASSETS_DIR, `${plugin.name}.png`)),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies nothing without assets/icons, so render-only fixtures stay stable", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-zcode-noicons-"));
    cpSync(join(ROOT, PLUGINS_DIR), join(root, PLUGINS_DIR), { recursive: true });
    try {
      await writeZcodeHarness(root);
      for (const name of HARNESS_PACKAGES) {
        expect(existsSync(join(root, ZCODE_HARNESS_DIR, name, "icon.png")), name).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
