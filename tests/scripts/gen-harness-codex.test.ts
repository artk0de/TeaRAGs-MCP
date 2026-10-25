import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CODEX_HARNESS_DIR,
  CODEX_MARKETPLACE_PATH,
  DINOPOWERS_SKILLS_LIST_BUDGET,
  renderCodexHarness,
  renderCodexMarketplace,
  SKILLS_LIST_BUDGET,
  toCodexSkill,
  writeCodexHarness,
} from "../../scripts/gen-harness-codex.js";
import { PLUGINS_DIR } from "../../scripts/harness/package.js";
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
  it("renders byte-identically twice", async () => {
    expect(await renderCodexHarness(ROOT)).toEqual(await renderCodexHarness(ROOT));
    expect(await renderCodexMarketplace(ROOT)).toBe(await renderCodexMarketplace(ROOT));
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
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionStart", "SubagentStart"]);
    expect(JSON.stringify(hooks)).not.toContain("CLAUDE_");
    // A cold `tea-rags prime` boots the server (measured 12–26 s); `project exist` ~4 s.
    expect(hooks.SessionStart[0].hooks[0].timeout).toBeGreaterThanOrEqual(60);
    expect(hooks.SubagentStart[0].hooks[0].timeout).toBeGreaterThanOrEqual(30);
    const marketplace = JSON.parse(await renderCodexMarketplace(ROOT));
    expect(marketplace.plugins[0].source).toEqual({ source: "local", path: "./harness/codex/tea-rags" });
    expect(rendered.has("tea-rags/.codex-plugin/plugin.json")).toBe(true);
  });

  it("SessionStart hands core and the prime digest to the session; core alone without the CLI", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const { hooks } = JSON.parse(rendered.get("tea-rags/hooks/hooks.json") ?? "");
    const command: string = hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe("${PLUGIN_ROOT}/scripts/session-start.sh");

    const pluginRoot = mkdtempSync(join(tmpdir(), "codex-tea-rags-"));
    const bin = mkdtempSync(join(tmpdir(), "codex-bin-"));
    try {
      mkdirSync(join(pluginRoot, "scripts"));
      for (const [path, content] of rendered) {
        if (!path.startsWith("tea-rags/scripts/")) continue;
        writeFileSync(join(pluginRoot, path.replace(/^tea-rags\//, "")), content, { flag: "w" });
      }
      writeFileSync(join(bin, "tea-rags"), '#!/bin/bash\necho "PRIME-DIGEST for $2"\n', { mode: 0o755 });
      const script = join(pluginRoot, "scripts", "session-start.sh");
      const run = (path: string): string =>
        JSON.parse(
          execFileSync("bash", [script], {
            env: { ...process.env, PWD: undefined, PLUGIN_ROOT: pluginRoot, PATH: path },
            cwd: bin,
            input: "{}",
          }).toString(),
        ).hookSpecificOutput.additionalContext;

      const withCli = run(`${bin}:/usr/bin:/bin`);
      expect(withCli).toContain("# tea-rags core");
      expect(withCli).toContain(`PRIME-DIGEST for ${realpathSync(bin)}`);

      const withoutCli = run("/usr/bin:/bin");
      expect(withoutCli).toContain("# tea-rags core");
      expect(withoutCli).not.toContain("PRIME-DIGEST");
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
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

  it("ships a PreToolUse hook that rejects shell commands printing more than one .md file", async () => {
    const rendered = await renderCodexHarness(ROOT);
    const { hooks } = JSON.parse(rendered.get("tea-rags/hooks/hooks.json") ?? "");

    expect(hooks.PreToolUse).toEqual([
      {
        matcher: "^(Bash|shell|exec_command)$",
        hooks: [{ type: "command", command: `\${PLUGIN_ROOT}/scripts/one-file-read.sh`, timeout: 10 }],
      },
    ]);
    const script = rendered.get("tea-rags/scripts/one-file-read.sh") ?? "";
    expect(script).toMatch(/^#!\/bin\/bash\n/);
    expect(script).toContain("ONE file per command");
    expect(script).toContain("exit 2");
    expect(script).not.toContain("CLAUDE_");
  });

  it("tells the core to open a skill's SKILL.md and its mandatory references before planning", async () => {
    const rendered = await renderCodexHarness(ROOT);

    for (const path of ["tea-rags/skills/tea-rags-core/SKILL.md", "AGENTS.tea-rags.md"]) {
      expect(rendered.get(path)).toMatch(/open its `SKILL\.md`/);
      expect(rendered.get(path)).toMatch(/MANDATORY/);
    }
  });

  // Codex T22: "I would read the skill" planned instead of read; a wrapper's hand-off target never opened.
  it("tells the core to read the skill in the same turn, and the skill a wrapper hands off to", async () => {
    const rendered = await renderCodexHarness(ROOT);

    for (const path of ["tea-rags/skills/tea-rags-core/SKILL.md", "AGENTS.tea-rags.md"]) {
      expect(rendered.get(path)).toMatch(/this turn/);
      expect(rendered.get(path)).toMatch(/hands off to/);
    }
  });

  // Codex T22 r3: one `cat` of three skills (50 KB) lost its middle to the ~10k-token exec-output cap; the model filled the gap.
  it("tells the core to read one file per command and to re-read a truncated one in ranges", async () => {
    const rendered = await renderCodexHarness(ROOT);

    for (const path of ["tea-rags/skills/tea-rags-core/SKILL.md", "AGENTS.tea-rags.md"]) {
      expect(rendered.get(path)).toMatch(/ONE file per command/);
      expect(rendered.get(path)).toMatch(/tokens truncated/);
      // Codex T22 r16: five skills printed by one `python3 -c` loop (88 KB) dropped risk-assessment's contract.
      expect(rendered.get(path)).toMatch(/any\s+tool\s+alike\s+\(`cat`,\s+`sed`,\s+`python3`,\s+a\s+loop\)/);
      // Codex T22 r3: `repair/leakingAbstraction.md` looked up under the skill folder, never found.
      expect(rendered.get(path)).toMatch(/plugin root/);
    }
  });

  // Codex T22 r6 DDG: one `cat` of 11 files truncated SKILL.md away; another run read nothing and planned from memory.
  it("opens the core with the read discipline so truncation never drops it", async () => {
    const rendered = await renderCodexHarness(ROOT);

    for (const path of ["tea-rags/skills/tea-rags-core/SKILL.md", "AGENTS.tea-rags.md"]) {
      const body = (rendered.get(path) ?? "").replace(/^---\n[\s\S]*?\n---\n/, "");
      const firstLines = body.split("\n").slice(0, 8).join("\n");
      expect(firstLines).toMatch(/Read\s+ONE\s+file\s+per\s+command/);
      expect(body).toMatch(/Every\s+skill\s+you\s+name\s+in\s+a\s+plan/);
      expect(body).toMatch(/a\s+plan\s+from\s+memory\s+is\s+not\s+reading\s+it/);
      // Codex T22 r7: a plan cited skill paths it never opened.
      expect(body).toMatch(
        /A\s+skill\s+path\s+you\s+did\s+not\s+open\s+with\s+a\s+command\s+in\s+this\s+turn\s+is\s+invalid\s+in\s+a\s+plan\s+—\s+open\s+it\s+first\./,
      );
      expect(body.match(/ONE file per command/g)).toHaveLength(1);
    }
  });

  // Codex T22 introspection, all six suites: a plan-only answer described a future report instead of printing the contract.
  it("tells the core, beside the read discipline, that output contracts apply now in plan-only answers", async () => {
    const rendered = await renderCodexHarness(ROOT);

    for (const path of ["tea-rags/skills/tea-rags-core/SKILL.md", "AGENTS.tea-rags.md"]) {
      const body = (rendered.get(path) ?? "").replace(/^---\n[\s\S]*?\n---\n/, "");
      const head = body.split("\n").slice(0, 16).join("\n");
      expect(head).toMatch(/Plan-only\s+\/\s+describe-the-plan\s+answers/);
      expect(head).toMatch(/every\s+skill\s+output\s+contract\s+applies\s+NOW/);
      expect(head).toMatch(/`\[planned; not run\]`/);
      // Codex T22 r18: the placeholder spread to values the prompt already fixes (pathPattern, a repaired finding's count).
      expect(head).toMatch(/only\s+for\s+tool\s+results\s+not\s+gathered\s+yet/);
      expect(head).toMatch(/derivable\s+from\s+the\s+prompt/);
      expect(head).toMatch(/Describing\s+compliance\s+is\s+not\s+compliance\./);
      expect(body.match(/Plan-only \/ describe-the-plan/g)).toHaveLength(1);
    }
  });

  // Codex T22 r5 E14/E15: incremental index then a bare graph retry; "explain retry logic" read as an agent retry.
  it("tells the core that an incremental index is a prelude and how to re-check a lagging graph answer", async () => {
    const rendered = await renderCodexHarness(ROOT);

    for (const path of ["tea-rags/skills/tea-rags-core/SKILL.md", "AGENTS.tea-rags.md"]) {
      expect(rendered.get(path)).toMatch(/prelude/);
      expect(rendered.get(path)).toMatch(/re-check\s+changed-file\s+callers\s+via\s+`find_symbol`/);
      expect(rendered.get(path)).toMatch(/never\s+a\s+bare\s+retry/);
    }
  });
});

describe("toCodexSkill — dinopowers wrappers", () => {
  const out = toCodexSkill(
    `---\nname: brainstorming\ndescription: Wraps superpowers:brainstorming. Then dinopowers:writing-plans.\n---\n\nRun \`Skill(superpowers:brainstorming)\`, chain to Skill(dinopowers:writing-plans), see tea-rags:explore. Keep \`superpowers:*\`; \`superpowers:Y\` → \`dinopowers:Y\`.\n`,
    { skillNames: new Set(["explore", "dino-writing-plans"]), wrappers: true },
  );

  it("mentions superpowers skills by their own name and wrappers by their dino- name", () => {
    expect(parseFrontmatter(out).fields.description).toBe("Wraps $brainstorming. Then $dino-writing-plans.");
    expect(out).toContain(
      "Run `$brainstorming`, chain to $dino-writing-plans, see $explore. Keep `superpowers:*`; `$Y` → `$dino-Y`.",
    );
  });

  it("keeps the plugin-qualified name in the availability clause, as Codex lists plugin skills", () => {
    const clause = toCodexSkill(
      "---\nname: brainstorming\n---\n\nAvailable = `$brainstorming` /\n`superpowers:brainstorming` is in your skills list.\n",
      { skillNames: new Set(), wrappers: true },
    );

    expect(clause).toContain("Available = `$brainstorming` /\n`superpowers:brainstorming` is in your skills list.");
  });
});

describe("renderCodexHarness — dinopowers package", () => {
  let rendered: Map<string, string>;
  const wrappers = () => [...rendered].filter(([path]) => /^dinopowers\/skills\/[^/]+\/SKILL\.md$/.test(path));

  beforeAll(async () => {
    rendered = await renderCodexHarness(ROOT);
  });

  it("writes a manifest with skills and hooks and no MCP server of its own", () => {
    const manifest = JSON.parse(rendered.get("dinopowers/.codex-plugin/plugin.json") ?? "");

    expect(manifest).toMatchObject({ name: "dinopowers", skills: "./skills/", hooks: "./hooks/hooks.json" });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.mcpServers).toBeUndefined();
  });

  it("ships every wrapper as dino-<name>, mentioning its superpowers skill and the install line", () => {
    expect(wrappers().length).toBe(10);
    for (const [path, content] of wrappers()) {
      const { fields, body } = parseFrontmatter(content);
      expect(Object.keys(fields), path).toEqual(["name", "description"]);
      expect(fields.name).toMatch(/^dino-/);
      expect(path).toBe(`dinopowers/skills/${fields.name}/SKILL.md`);
      expect(body, path).toContain(`$${fields.name.slice("dino-".length)}`);
      expect(body, path).toContain("https://github.com/obra/superpowers");
      const listed = /`superpowers:[a-z-]+`\s+is\s+in\s+your\s+skills\s+list/g;
      expect(content.replace(listed, ""), path).not.toMatch(/\b(?:dinopowers|superpowers):[A-Za-z]/);
      expect(content, path).not.toMatch(/Skill\(/);
    }
  });

  it("keeps the dinopowers skills list within its own budget", () => {
    const total = wrappers().reduce((sum, [, content]) => {
      const { fields } = parseFrontmatter(content);
      return sum + fields.name.length + fields.description.length;
    }, 0);

    expect(total).toBeLessThanOrEqual(DINOPOWERS_SKILLS_LIST_BUDGET);
  });

  it("resolves every relative link inside the package", () => {
    const missing: string[] = [];
    for (const [path, content] of rendered) {
      if (!path.startsWith("dinopowers/") || !path.endsWith(".md")) continue;
      for (const [, link] of content.matchAll(/\]\(((?:\.\.\/)*[\w./-]+\.md)\)/g)) {
        if (!rendered.has(join(dirname(path), link))) missing.push(`${path} → ${link}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("injects the routing table at SessionStart and SubagentStart in Codex mention syntax", () => {
    const { hooks } = JSON.parse(rendered.get("dinopowers/hooks/hooks.json") ?? "");

    expect(Object.keys(hooks).sort()).toEqual(["SessionStart", "SubagentStart"]);
    for (const event of ["SessionStart", "SubagentStart"]) {
      const [
        {
          hooks: [{ command }],
        },
      ] = hooks[event];
      expect(command).toMatch(/^\$\{PLUGIN_ROOT\}\/scripts\/[\w-]+\.sh$/);
      const script = rendered.get(`dinopowers/${command.replace(/^\$\{PLUGIN_ROOT\}\//, "")}`) ?? "";
      expect(script, event).toContain(`hookEventName: "${event}"`);
      expect(script, event).toContain("additionalContext");
      expect(script, event).not.toContain("CLAUDE_");
      const [, txt] = /scripts\/([\w-]+\.txt)/.exec(script) ?? [];
      const table = rendered.get(`dinopowers/scripts/${txt}`) ?? "";
      expect(table, event).toContain("$dino-brainstorming");
      expect(table, event).toContain("$data-driven-generation");
      expect(table, event).not.toContain("Skill(");
    }
  });

  it("routing hook names the installed SKILL.md of every routed skill, in both plugins", () => {
    const cache = mkdtempSync(join(tmpdir(), "codex-cache-"));
    try {
      const dino = join(cache, "tea-rags", "dinopowers", "0.1.0");
      const teaRags = join(cache, "tea-rags", "tea-rags", "0.2.0");
      for (const [path, content] of rendered) {
        const [plugin, ...rest] = path.split("/");
        if (plugin !== "dinopowers" && plugin !== "tea-rags") continue;
        const target = join(plugin === "dinopowers" ? dino : teaRags, ...rest);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }

      for (const script of ["main-session-routing.sh", "wrapper-routing.sh"]) {
        const out = execFileSync("bash", [join(dino, "scripts", script)], {
          env: { ...process.env, PLUGIN_ROOT: dino },
          input: "{}",
        }).toString();
        const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;

        expect(context, script).toContain(`$dino-brainstorming → ${dino}/skills/dino-brainstorming/SKILL.md`);
        expect(context, script).toContain(
          `$data-driven-generation → ${teaRags}/skills/data-driven-generation/SKILL.md`,
        );
      }
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("lists both plugins in the root marketplace", async () => {
    const marketplace = JSON.parse(await renderCodexMarketplace(ROOT));

    expect(marketplace.plugins.map((plugin: { source: { path: string } }) => plugin.source.path)).toEqual([
      "./harness/codex/tea-rags",
      "./harness/codex/dinopowers",
    ]);
  });
});

describe("writeCodexHarness", () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "harness-codex-"));
    cpSync(join(ROOT, PLUGINS_DIR), join(fixtureRoot, PLUGINS_DIR), { recursive: true });
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const snapshot = () => {
    const dir = join(fixtureRoot, CODEX_HARNESS_DIR);
    return listFiles(dir)
      .map((file) => [relative(dir, file), readFileSync(file, "utf8")])
      .sort(([a], [b]) => a.localeCompare(b));
  };

  it("writes exactly the rendered package and marketplace manifest, dropping stale files", async () => {
    const stale = join(fixtureRoot, CODEX_HARNESS_DIR, "tea-rags", "stale.md");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "stale\n");

    await writeCodexHarness(fixtureRoot);

    const rendered = await renderCodexHarness(fixtureRoot);
    expect(snapshot()).toEqual([...rendered].sort(([a], [b]) => a.localeCompare(b)));
    expect(readFileSync(join(fixtureRoot, CODEX_MARKETPLACE_PATH), "utf8")).toBe(
      await renderCodexMarketplace(fixtureRoot),
    );
  });

  it("is idempotent", async () => {
    await writeCodexHarness(fixtureRoot);
    const first = snapshot();
    await writeCodexHarness(fixtureRoot);
    expect(snapshot()).toEqual(first);
  });
});
