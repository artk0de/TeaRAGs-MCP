import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CORE_RULE_MAX_CHARS,
  CURSOR_HARNESS_DIR,
  CURSOR_MARKETPLACE_PATH,
  renderCursorHarness,
  renderCursorMarketplace,
  toCursorSkill,
  writeCursorHarness,
} from "../../scripts/gen-harness-cursor.js";
import { PLUGIN_SRC, PLUGINS_DIR } from "../../scripts/harness/package.js";
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

const CODE_SEARCH_SOURCE = `---
name: bug-hunt
description: Find source of concrete failure.
---

TODO markers → default code search tool, never tea-rags.
Print \`default code search tool "<phrase>" (literal) → find_symbol\`.
Wrapped: the default
  code search tool (not a tea-rags tool).
Never read with the default code read tool or
  the default code read tool again.
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

  it("names Cursor's Grep tool for the default code search tool and the Read tool for the default code read tool, wrapped lines included", () => {
    const text = toCursorSkill(CODE_SEARCH_SOURCE, { skillNames: KNOWN });

    expect(text).toContain("TODO markers → Grep tool, never tea-rags.");
    expect(text).toContain('Print `Grep tool "<phrase>" (literal) → find_symbol`.');
    expect(text).toContain("Wrapped: Grep tool (not a tea-rags tool).");
    expect(text).toContain("Never read with Read tool or\n  Read tool again.");
    expect(text).not.toMatch(/default\s+code\s+(?:search|read)\s+tool/);
  });

  it("keeps only name and description and mentions skills as slash commands", () => {
    const { fields } = parseFrontmatter(out);

    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.description).toBe("Build a raw filter. Use /explore first.");
    expect(out).toContain("Chain /explore, then `/test-first`.");
  });

  it("keeps the full description and drops codex-description", () => {
    const withCodex = toCursorSkill(
      "---\nname: explore\ndescription: Full text.\ncodex-description:\n  Short.\n---\n\n# Explore\n\nBody.\n",
      { skillNames: KNOWN },
    );
    const { fields } = parseFrontmatter(withCodex);

    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.description).toBe("Full text.");
    expect(withCodex).not.toContain("Short.");
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

  it("renders byte-identically twice", async () => {
    expect(await renderCursorHarness(ROOT)).toEqual(rendered);
  });

  it("renders the root marketplace manifest pointing at a package that carries its manifest", async () => {
    const marketplace = await renderCursorMarketplace(ROOT);

    expect(rendered.has("tea-rags/.cursor-plugin/plugin.json")).toBe(true);
    expect(JSON.parse(marketplace)).toMatchObject({
      name: "tea-rags",
      owner: { name: expect.any(String) },
      plugins: expect.arrayContaining([{ name: "tea-rags", source: "./harness/cursor/tea-rags" }]),
    });
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
    const [{ command, timeout }] = hooks.hooks.sessionStart;
    expect(command).toBe(`bash "\${CURSOR_PLUGIN_ROOT}/scripts/session-start.sh"`);
    // A cold `tea-rags prime` boots the server (measured 12–26 s).
    expect(timeout).toBeGreaterThanOrEqual(60);
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
      .filter(
        ([path, content]) => /\.mdc?$/.test(path) && path.startsWith("tea-rags/") && content.includes("tea-rags://"),
      )
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
    cpSync(join(ROOT, PLUGINS_DIR), join(fixtureRoot, PLUGINS_DIR), { recursive: true });
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("emits no core rule and says so in the README while rules/core.md is absent", async () => {
    rmSync(join(fixtureRoot, PLUGIN_SRC, "rules/core.md"), { force: true });
    const out = await renderCursorHarness(fixtureRoot);

    expect([...out.keys()].some((path) => path.endsWith(".mdc"))).toBe(false);
    expect(out.get("README.md")).toContain("`rules/core.md` does not exist yet");
  });

  it("emits rules/core.md as an alwaysApply rule with both resource routes", async () => {
    writeFileSync(
      join(fixtureRoot, PLUGIN_SRC, "rules/core.md"),
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

  it("fits a core at its 7,700-char cap, wrapper included, under the rule cap", async () => {
    const line = "Pass project= and path= on every tea-rags read call; see tea-rags://guide/navigation.\n";
    const core = `# tea-rags core\n\n${line.repeat(Math.ceil(8_500 / line.length))}`.slice(0, 8_500);
    writeFileSync(join(fixtureRoot, PLUGIN_SRC, "rules/core.md"), core);
    const out = await renderCursorHarness(fixtureRoot);
    const rule = out.get("tea-rags/rules/tea-rags-core.mdc") ?? "";

    expect(rule.length).toBeGreaterThan(8_500);
    expect(rule.length).toBeLessThanOrEqual(CORE_RULE_MAX_CHARS);
  });
});

describe("renderCursorHarness — dinopowers package", () => {
  let rendered: Map<string, string>;
  const wrappers = () => [...rendered].filter(([path]) => /^dinopowers\/skills\/[^/]+\/SKILL\.md$/.test(path));

  beforeAll(async () => {
    rendered = await renderCursorHarness(ROOT);
  });

  it("writes a manifest with documented fields only and no MCP server of its own", () => {
    const manifest = JSON.parse(rendered.get("dinopowers/.cursor-plugin/plugin.json") ?? "");

    expect(Object.keys(manifest).filter((key) => !MANIFEST_FIELDS.has(key))).toEqual([]);
    expect(manifest.name).toBe("dinopowers");
    expect(rendered.has("dinopowers/mcp.json")).toBe(false);
  });

  it("ships every wrapper as dino-<name>, mentioning its superpowers skill and the install line", () => {
    expect(wrappers().length).toBe(10);
    for (const [path, content] of wrappers()) {
      const { fields, body } = parseFrontmatter(content);
      expect(Object.keys(fields), path).toEqual(["name", "description"]);
      expect(fields.name).toMatch(/^dino-/);
      expect(path).toBe(`dinopowers/skills/${fields.name}/SKILL.md`);
      expect(body, path).toContain(`/${fields.name.slice("dino-".length)}`);
      expect(body, path).toContain("https://github.com/obra/superpowers");
      expect(content, path).not.toMatch(/\b(?:dinopowers|superpowers):[A-Za-z]/);
      expect(content, path).not.toMatch(/Skill\(/);
    }
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

  it("injects the main-session routing table at sessionStart only, in slash-mention syntax", () => {
    const hooks = JSON.parse(rendered.get("dinopowers/hooks/hooks.json") ?? "");

    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual(["sessionStart"]);
    const [{ command }] = hooks.hooks.sessionStart;
    expect(command).toBe(`bash "\${CURSOR_PLUGIN_ROOT}/scripts/session-start.sh"`);
    const script = rendered.get("dinopowers/scripts/session-start.sh") ?? "";
    expect(script).toContain("additional_context");
    expect(script).not.toContain("CLAUDE_");
    const table = rendered.get("dinopowers/scripts/main-session-routing.txt") ?? "";
    expect(table).toContain("/dino-brainstorming");
    expect(table).toContain("/data-driven-generation");
    expect(table).not.toContain("Skill(");
  });

  it("lists both plugins in the root marketplace", async () => {
    const { plugins } = JSON.parse(await renderCursorMarketplace(ROOT));

    expect(plugins).toEqual([
      { name: "tea-rags", source: "./harness/cursor/tea-rags" },
      { name: "dinopowers", source: "./harness/cursor/dinopowers" },
    ]);
  });
});

describe("renderCursorHarness — tea-rags sessionStart script", () => {
  /** Cursor rejects a hook's additional_context longer than this (HookAdditionalContextTooLargeError). */
  const CURSOR_CONTEXT_MAX_CHARS = 10_000;
  let dir: string;
  let script: string;
  let pluginDir: string;

  /** A fake `tea-rags` that records its arguments and prints `digestChars` characters. */
  function fakeBin(name: string, digestChars = 40): string {
    const binDir = join(dir, name);
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "tea-rags");
    writeFileSync(bin, `#!/bin/bash\necho "$@" > "${join(binDir, "args")}"\nprintf 'D%.0s' $(seq 1 ${digestChars})\n`);
    chmodSync(bin, 0o755);
    return binDir;
  }

  function run(stdin: string, env: Record<string, string>): { context?: string; raw: string; status: number | null } {
    const result = spawnSync("/bin/bash", [script], {
      cwd: pluginDir,
      input: stdin,
      encoding: "utf8",
      env: { HOME: dir, ...env, PATH: `${env.PATH ?? ""}:/usr/bin:/bin:/opt/homebrew/bin` },
    });
    const parsed = JSON.parse(result.stdout || "null") as { additional_context?: string } | null;
    return { context: parsed?.additional_context, raw: result.stdout, status: result.status };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cursor-hook-"));
    pluginDir = join(dir, "plugin");
    mkdirSync(pluginDir);
    script = join(pluginDir, "session-start.sh");
    writeFileSync(script, (await renderCursorHarness(ROOT)).get("tea-rags/scripts/session-start.sh") ?? "");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("primes CURSOR_PROJECT_DIR, not the plugin directory the hook runs in", () => {
    const bin = fakeBin("a");
    const out = run("{}", { PATH: bin, CURSOR_PROJECT_DIR: "/work/project" });

    expect(out.context).toMatch(/^D+$/);
    expect(readFileSync(join(bin, "args"), "utf8").trim()).toBe("prime /work/project");
  });

  it("falls back to the first workspace root on stdin", () => {
    const bin = fakeBin("b");
    run('{"workspace_roots":["/work/other"]}', { PATH: bin });

    expect(readFileSync(join(bin, "args"), "utf8").trim()).toBe("prime /work/other");
  });

  it("answers {} without priming when no project directory is known", () => {
    const bin = fakeBin("c");
    const out = run("{}", { PATH: bin });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.raw)).toEqual({});
    expect(() => readFileSync(join(bin, "args"), "utf8")).toThrow();
  });

  it("finds tea-rags through TEA_RAGS_BIN when it is not on PATH", () => {
    const bin = fakeBin("d");
    const out = run("{}", { TEA_RAGS_BIN: join(bin, "tea-rags"), CURSOR_PROJECT_DIR: "/work/project" });

    expect(out.context).toMatch(/^D+$/);
  });

  it("answers {} and exits 0 when no tea-rags binary is found", () => {
    const out = run("{}", { CURSOR_PROJECT_DIR: "/work/project" });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.raw)).toEqual({});
  });

  it("caps the digest at Cursor's additional_context limit", () => {
    const bin = fakeBin("e", 12_000);
    const out = run("{}", { PATH: bin, CURSOR_PROJECT_DIR: "/work/project" });

    expect(out.context?.length).toBeGreaterThan(0);
    expect(out.context?.length).toBeLessThanOrEqual(CURSOR_CONTEXT_MAX_CHARS);
  });
});

describe("renderCursorHarness — live-test record", () => {
  it("ships LIVE-TEST.md naming the Cursor and cursor-agent versions it was run with", async () => {
    const live = (await renderCursorHarness(ROOT)).get("LIVE-TEST.md") ?? "";

    expect(live).toContain("GENERATED by `scripts/gen-harness-cursor.ts`");
    expect(live).toMatch(/cursor-agent\s+`\d{4}\.\d{2}\.\d{2}-[0-9a-f]+`/);
  });
});

describe("writeCursorHarness", () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "harness-cursor-write-"));
    cpSync(join(ROOT, PLUGINS_DIR), join(fixtureRoot, PLUGINS_DIR), { recursive: true });
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const snapshot = () => {
    const dir = join(fixtureRoot, CURSOR_HARNESS_DIR);
    return listFiles(dir)
      .map((file) => [relative(dir, file), readFileSync(file, "utf8")])
      .sort(([a], [b]) => a.localeCompare(b));
  };

  it("writes exactly the rendered package and marketplace manifest, dropping stale files", async () => {
    const stale = join(fixtureRoot, CURSOR_HARNESS_DIR, "tea-rags", "stale.md");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "stale\n");

    await writeCursorHarness(fixtureRoot);

    const rendered = await renderCursorHarness(fixtureRoot);
    expect(snapshot()).toEqual([...rendered].sort(([a], [b]) => a.localeCompare(b)));
    expect(readFileSync(join(fixtureRoot, CURSOR_MARKETPLACE_PATH), "utf8")).toBe(
      await renderCursorMarketplace(fixtureRoot),
    );
  });

  it("is idempotent", async () => {
    await writeCursorHarness(fixtureRoot);
    const first = snapshot();
    await writeCursorHarness(fixtureRoot);
    expect(snapshot()).toEqual(first);
  });
});
