import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderCodexHarness, renderCodexMarketplace } from "../../scripts/gen-harness-codex.js";
import { renderCursorHarness, renderCursorMarketplace } from "../../scripts/gen-harness-cursor.js";
import { parseFrontmatter } from "../../scripts/harness/transform.js";

const ROOT = resolve(__dirname, "../..");
const SETUP_SOURCE = join(ROOT, "plugins/tea-rags-setup");
const SETUP_VERSION = (
  JSON.parse(readFileSync(join(SETUP_SOURCE, ".claude-plugin/plugin.json"), "utf8")) as { version: string }
).version;
const SETUP_SCRIPTS = readdirSync(join(SETUP_SOURCE, "scripts")).filter((file) => file.endsWith(".mjs"));
const SETUP_SKILLS = readdirSync(join(SETUP_SOURCE, "skills"));

describe.each([
  {
    harness: "codex",
    render: renderCodexHarness,
    manifest: "tea-rags-setup/.codex-plugin/plugin.json",
    rootVar: "{PLUGIN_ROOT}",
  },
  {
    harness: "cursor",
    render: renderCursorHarness,
    manifest: "tea-rags-setup/.cursor-plugin/plugin.json",
    rootVar: "{CURSOR_PLUGIN_ROOT}",
  },
])("tea-rags-setup package for $harness", ({ render, manifest, rootVar }) => {
  it("ships a manifest carrying the source plugin version", async () => {
    const rendered = await render(ROOT);
    const parsed = JSON.parse(rendered.get(manifest) ?? "{}") as { name?: string; version?: string };

    expect(parsed).toMatchObject({ name: "tea-rags-setup", version: SETUP_VERSION });
  });

  it("ships the install skill in the harness dialect", async () => {
    const rendered = await render(ROOT);
    const skill = rendered.get("tea-rags-setup/skills/install/SKILL.md") ?? "";
    const { fields, body } = parseFrontmatter(skill);

    expect(fields.name).toBe("install");
    expect(fields.description?.trim()).toBeTruthy();
    expect(body).toContain(`$${rootVar}/scripts/detect.mjs`);
    expect(body).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("ships every source skill and every helper script", async () => {
    const rendered = await render(ROOT);

    for (const skill of SETUP_SKILLS) expect(rendered.has(`tea-rags-setup/skills/${skill}/SKILL.md`), skill).toBe(true);
    expect(SETUP_SCRIPTS.length).toBeGreaterThan(0);
    for (const script of SETUP_SCRIPTS) {
      expect(rendered.get(`tea-rags-setup/scripts/${script}`), script).toBe(
        readFileSync(join(SETUP_SOURCE, "scripts", script), "utf8"),
      );
    }
  });
});

describe("tea-rags-setup marketplace entries", () => {
  it("lists the setup plugin in the Codex marketplace", async () => {
    const { plugins } = JSON.parse(await renderCodexMarketplace(ROOT)) as {
      plugins: { name: string; source: { path: string } }[];
    };

    expect(plugins.find((plugin) => plugin.name === "tea-rags-setup")?.source.path).toBe(
      "./harness/codex/tea-rags-setup",
    );
  });

  it("lists the setup plugin in the Cursor marketplace", async () => {
    const { plugins } = JSON.parse(await renderCursorMarketplace(ROOT)) as {
      plugins: { name: string; source: string }[];
    };

    expect(plugins).toContainEqual({ name: "tea-rags-setup", source: "./harness/cursor/tea-rags-setup" });
  });
});
