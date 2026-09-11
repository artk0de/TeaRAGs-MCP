/**
 * `.claude/rules/index-format-versions.md` frontmatter ⟺ the digest sources
 * (bd tea-rags-mcp-1abzy).
 *
 * The rule's `paths:` globs are what SURFACES the rule when you edit a shared
 * source; `SHARED_SOURCES` in `capability/version-axes.ts` is what the
 * `sharedVersions` digest actually hashes. They are kept in lockstep by hand,
 * and each direction fails differently:
 *
 *  - a path in the rule that nothing digests turns `sharedVersions` into a
 *    number vouching for code it never saw. The rule fires, the pin test stays
 *    green because the digest did not move, and the bump gets skipped — which
 *    is the whole failure this rule exists to prevent.
 *  - a digested path no glob names is a file that moves every language's index
 *    format without the rule ever appearing to the session that edits it.
 *
 * The rule documents two carve-outs, and this test honours exactly those two —
 * `contracts/types/codegraph-*.ts` (rule-only, no `codegraphSchema` digest) and
 * the axes' own `exclude` lists (`kernel/capability.ts` HOLDS the numbers, so
 * digesting it would make every bump invalidate its own pin).
 */

import { readdirSync, readFileSync } from "node:fs";

import picomatch from "picomatch";
import { describe, expect, it } from "vitest";

import { versionAxisSources } from "../../../../../src/core/domains/language/capability/version-axes.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { SHARED_LANGUAGE } from "../../../../../src/core/domains/language/kernel/capability.js";

const RULE_PATH = ".claude/rules/index-format-versions.md";

/**
 * The one path family the rule deliberately lists without digesting it: the
 * `codegraphSchema` axis has no digest at all, so those files are rule-only and
 * their bump is a judgement call stated in the rule's own table.
 */
const RULE_ONLY = "src/core/contracts/types/codegraph-*.ts";

/** The frontmatter's `paths:` globs, in file order. */
function ruleGlobs(): string[] {
  const text = readFileSync(RULE_PATH, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  expect(frontmatter, `${RULE_PATH} has no YAML frontmatter — a rule without one is invisible to the loader`).not.toBe(
    null,
  );
  return [...(frontmatter?.[1] ?? "").matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
}

/**
 * Every non-test `.ts` under `src/`, repo-relative with POSIX separators — the
 * same predicate `digestSources` applies when it walks an axis's paths, so what
 * this test calls "a source" and what the digest hashes cannot diverge.
 */
function sourceTree(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .map((entry) => `src/${entry.split(/[\\/]/).join("/")}`)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();
}

/** True when `path` names the file itself or a directory containing it. */
function covers(path: string, file: string): boolean {
  return file === path || file.startsWith(`${path}/`);
}

/** Files an axis list reaches, split by whether the axis's `exclude` prunes them back out. */
function axisReach(
  languages: readonly string[],
  files: readonly string[],
): { digested: Set<string>; pruned: Set<string> } {
  const digested = new Set<string>();
  const pruned = new Set<string>();
  for (const language of languages) {
    for (const { paths, exclude } of versionAxisSources(language)) {
      for (const file of files) {
        if (!paths.some((path) => covers(path, file))) continue;
        if ((exclude ?? []).some((path) => covers(path, file))) pruned.add(file);
        else digested.add(file);
      }
    }
  }
  // A file one axis digests is digested, whatever another axis prunes.
  for (const file of digested) pruned.delete(file);
  return { digested, pruned };
}

describe("index-format-versions.md globs ⟺ the sharedVersions digest sources (bd tea-rags-mcp-1abzy)", () => {
  const globs = ruleGlobs();
  const files = sourceTree();
  const languages = [...new LanguageFactory().capabilities().keys(), SHARED_LANGUAGE];
  const { digested, pruned } = axisReach(languages, files);
  const matched = files.filter((file) => globs.some((glob) => picomatch.isMatch(file, glob)));

  it("surfaces on files that exist — every glob matches something", () => {
    // A glob that matches nothing is a path that was renamed or deleted without
    // the rule following it; it costs nothing at runtime and silently narrows
    // what the rule covers.
    expect(globs.filter((glob) => !files.some((file) => picomatch.isMatch(file, glob)))).toEqual([]);
  });

  it("digests every source the rule claims", () => {
    const undigested = matched.filter(
      (file) => !digested.has(file) && !pruned.has(file) && !picomatch.isMatch(file, RULE_ONLY),
    );

    expect(
      undigested,
      `listed in ${RULE_PATH} but hashed by no axis — sharedVersions would vouch for code it never saw. ` +
        `Add them to SHARED_SOURCES in src/core/domains/language/capability/version-axes.ts, ` +
        `or drop them from the rule's paths:.`,
    ).toEqual([]);
  });

  it("surfaces the rule on every source the shared digest hashes", () => {
    const shared = axisReach([SHARED_LANGUAGE], files).digested;
    const unsurfaced = [...shared].filter((file) => !globs.some((glob) => picomatch.isMatch(file, glob))).sort();

    expect(
      unsurfaced,
      `hashed by SHARED_SOURCES but matched by no paths: glob in ${RULE_PATH} — editing them moves every ` +
        `language's index format with the rule staying invisible. Add a glob covering them.`,
    ).toEqual([]);
  });
});
