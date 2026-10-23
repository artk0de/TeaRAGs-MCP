import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

type PluginEntry = string | [string, Record<string, unknown>];

function pluginConfig(name: string): Record<string, unknown> {
  const { plugins } = JSON.parse(readFileSync(resolve(ROOT, ".releaserc.json"), "utf8")) as {
    plugins: PluginEntry[];
  };
  const entry = plugins.find((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name);
  expect(entry, name).toBeDefined();
  return Array.isArray(entry) ? entry[1] : {};
}

/**
 * The release owns regeneration of everything rendered from plugins/**: a PR may
 * edit sources without regenerating, and the `chore(release)` commit carries
 * the regenerated packages. `semantic-release --dry-run` needs the remote and
 * tokens, so the config is pinned here instead.
 */
describe("release regenerates the generated packages", () => {
  it("runs npm run gen:plugins in the exec prepare step, after the changelog", () => {
    const { prepareCmd } = pluginConfig("@semantic-release/exec") as { prepareCmd: string };

    expect(prepareCmd.split(" && ").slice(0, 2)).toEqual([
      "bash scripts/prepare-changelog.sh",
      "npm run gen:plugins",
    ]);
  });

  it("commits every generated path with the release", () => {
    const { assets } = pluginConfig("@semantic-release/git") as { assets: string[] };

    expect(assets).toEqual(
      expect.arrayContaining([
        ".claude-plugin/**",
        ".agents/**",
        ".cursor-plugin/**",
        "harness/**",
        "src/mcp/resources/generated/**",
      ]),
    );
  });

  it("regenerates the agent context before every build, which compiles it into the server", () => {
    const { scripts } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(scripts.prebuild).toContain("npm run -s gen:agent-context");
  });
});
