import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLAUDE_PACKAGES_DIR,
  claudePluginNames,
  renderClaudePackage,
  writeClaudePackages,
} from "../../scripts/gen-harness-claude.js";
import { PLUGINS_DIR, walk } from "../../scripts/harness/package.js";

const ROOT = resolve(__dirname, "../..");

const PLUGIN_ROOT_PATH = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"]+)/g;

describe("claudePluginNames", () => {
  it("lists every source plugin that carries a manifest", () => {
    expect(claudePluginNames(ROOT)).toEqual(["dinopowers", "tea-rags", "tea-rags-setup"]);
  });
});

describe.each(["tea-rags", "dinopowers", "tea-rags-setup"])("renderClaudePackage(%s)", (name) => {
  it("copies the source verbatim, executable bits included", () => {
    const rendered = renderClaudePackage(ROOT, name);
    const src = join(ROOT, PLUGINS_DIR, name);

    expect([...rendered.keys()].sort()).toEqual(
      walk(src)
        .map((file) => relative(src, file))
        .sort(),
    );
    for (const [path, file] of rendered) {
      expect(file.content.equals(readFileSync(join(src, path))), path).toBe(true);
      expect(file.mode & 0o111, path).toBe(statSync(join(src, path)).mode & 0o111);
    }
  });

  it("renders byte-identically twice", () => {
    expect(renderClaudePackage(ROOT, name)).toEqual(renderClaudePackage(ROOT, name));
  });

  it("resolves every hook command path to an executable file inside the package", () => {
    const rendered = renderClaudePackage(ROOT, name);
    const manifest = rendered.get(".claude-plugin/plugin.json");
    expect(manifest).toBeDefined();
    const text = manifest?.content.toString("utf8") ?? "";
    JSON.parse(text);

    for (const [, path] of text.matchAll(PLUGIN_ROOT_PATH)) {
      const file = rendered.get(path);
      expect(file, path).toBeDefined();
      expect((file?.mode ?? 0) & 0o111, `${path} executable`).not.toBe(0);
    }
  });
});

describe("writeClaudePackages", () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "harness-claude-"));
    cpSync(join(ROOT, PLUGINS_DIR), join(fixtureRoot, PLUGINS_DIR), { recursive: true });
    cpSync(
      join(ROOT, CLAUDE_PACKAGES_DIR, "marketplace.json"),
      join(fixtureRoot, CLAUDE_PACKAGES_DIR, "marketplace.json"),
    );
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("replaces stale package files and leaves the marketplace manifest alone", () => {
    const stale = join(fixtureRoot, CLAUDE_PACKAGES_DIR, "tea-rags", "stale.md");
    cpSync(join(ROOT, PLUGINS_DIR, "tea-rags"), join(fixtureRoot, CLAUDE_PACKAGES_DIR, "tea-rags"), {
      recursive: true,
    });
    writeFileSync(stale, "stale\n");

    writeClaudePackages(fixtureRoot);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(fixtureRoot, CLAUDE_PACKAGES_DIR, "marketplace.json"))).toBe(true);
    for (const name of claudePluginNames(fixtureRoot)) {
      const dir = join(fixtureRoot, CLAUDE_PACKAGES_DIR, name);
      const rendered = renderClaudePackage(fixtureRoot, name);
      expect(
        walk(dir)
          .map((file) => relative(dir, file))
          .sort(),
        name,
      ).toEqual([...rendered.keys()].sort());
      for (const [path, file] of rendered) {
        expect(lstatSync(join(dir, path)).isFile(), path).toBe(true);
        expect(readFileSync(join(dir, path)).equals(file.content), path).toBe(true);
        expect(statSync(join(dir, path)).mode & 0o111, `${path} executable bit`).toBe(file.mode & 0o111);
      }
    }
  });

  it("is idempotent", () => {
    const snapshot = () =>
      walk(join(fixtureRoot, CLAUDE_PACKAGES_DIR)).map((file) => [
        relative(fixtureRoot, file),
        readFileSync(file).toString("base64"),
        statSync(file).mode & 0o111,
      ]);
    writeClaudePackages(fixtureRoot);
    const first = snapshot();
    writeClaudePackages(fixtureRoot);
    expect(snapshot()).toEqual(first);
  });
});

describe("root marketplace manifests", () => {
  it.each([
    [".claude-plugin/marketplace.json", ".claude-plugin/plugin.json", (source: unknown) => source as string],
    [
      ".agents/plugins/marketplace.json",
      ".codex-plugin/plugin.json",
      (source: unknown) => (source as { path: string }).path,
    ],
    [".cursor-plugin/marketplace.json", ".cursor-plugin/plugin.json", (source: unknown) => source as string],
  ])("%s points every plugin at a package carrying %s", (manifestPath, pluginManifest, pathOf) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath), "utf8")) as {
      plugins: { name: string; source: unknown }[];
    };
    expect(manifest.plugins.length).toBeGreaterThan(0);
    for (const plugin of manifest.plugins) {
      const path = pathOf(plugin.source);
      expect(path, plugin.name).toMatch(/^\.\//);
      expect(existsSync(join(ROOT, path, pluginManifest)), `${plugin.name} → ${path}`).toBe(true);
    }
  });
});
