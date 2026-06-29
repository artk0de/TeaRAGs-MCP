import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format, resolveConfig } from "prettier";

import type { LanguageCapability } from "../src/core/contracts/types/language.js";
import { renderReadme } from "../src/core/domains/language/capability/readme.js";
import { renderRule } from "../src/core/domains/language/capability/rule.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";

const BEGIN = "<!-- BEGIN lang-compat -->";
const END = "<!-- END lang-compat -->";

const here = dirname(fileURLToPath(import.meta.url));

export interface GenPaths {
  rulePath: string;
  readmePath: string;
}

const DEFAULT_PATHS: GenPaths = {
  rulePath: resolve(here, "../.claude-plugin/tea-rags/rules/language-compatibility.md"),
  readmePath: resolve(here, "../README.md"),
};

/**
 * Format through Prettier with the project config so the committed artifacts
 * are byte-identical to what `lint-staged`'s `prettier --write` would produce —
 * the pre-commit hook is then a no-op and the drift-guard stays stable.
 */
async function formatMarkdown(source: string, filepath: string): Promise<string> {
  const config = await resolveConfig(filepath);
  return format(source, { ...config, filepath, parser: "markdown" });
}

function caps(): Map<string, LanguageCapability> {
  return new LanguageFactory().capabilities();
}

/** Prettier-formatted rule-file content from the descriptors. */
export async function renderRuleFile(
  capabilities: Map<string, LanguageCapability> = caps(),
  rulePath: string = DEFAULT_PATHS.rulePath,
): Promise<string> {
  return formatMarkdown(renderRule(capabilities), rulePath);
}

/**
 * Replace the README spoiler block between the markers (markers preserved) and
 * Prettier-format the whole file. Idempotent: re-running on its own output is a
 * no-op. Throws if the markers are missing.
 */
export async function spliceReadme(
  readme: string,
  capabilities: Map<string, LanguageCapability> = caps(),
  readmePath: string = DEFAULT_PATHS.readmePath,
): Promise<string> {
  const beginIdx = readme.indexOf(BEGIN);
  const endIdx = readme.indexOf(END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`README marker block "${BEGIN} … ${END}" not found in ${readmePath}`);
  }
  const before = readme.slice(0, beginIdx + BEGIN.length);
  const after = readme.slice(endIdx);
  return formatMarkdown(`${before}\n${renderReadme(capabilities)}\n${after}`, readmePath);
}

export async function writeArtifacts({ rulePath, readmePath }: GenPaths): Promise<void> {
  const capabilities = caps();
  writeFileSync(rulePath, await renderRuleFile(capabilities, rulePath), "utf8");
  const readme = readFileSync(readmePath, "utf8");
  writeFileSync(readmePath, await spliceReadme(readme, capabilities, readmePath), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeArtifacts(DEFAULT_PATHS);
  console.log("✓ language-compatibility.md + README block regenerated from capability descriptors.");
}
