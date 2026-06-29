import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderReadme } from "../src/core/domains/language/capability/readme.js";
import { renderRule } from "../src/core/domains/language/capability/rule.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";

const BEGIN = "<!-- BEGIN lang-compat -->";
const END = "<!-- END lang-compat -->";

export interface GenPaths {
  rulePath: string;
  readmePath: string;
}

/**
 * Regenerate both committed artifacts from the capability descriptors: the
 * agent rule file (full overwrite) and the README spoiler block (replace only
 * the content between the BEGIN/END markers, leaving the rest of the README
 * untouched). Idempotent — the renderers are deterministic.
 */
export function writeArtifacts({ rulePath, readmePath }: GenPaths): void {
  const caps = new LanguageFactory().capabilities();

  writeFileSync(rulePath, renderRule(caps), "utf8");

  const readme = readFileSync(readmePath, "utf8");
  const beginIdx = readme.indexOf(BEGIN);
  const endIdx = readme.indexOf(END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`README marker block "${BEGIN} … ${END}" not found in ${readmePath}`);
  }
  const before = readme.slice(0, beginIdx + BEGIN.length);
  const after = readme.slice(endIdx);
  writeFileSync(readmePath, `${before}\n${renderReadme(caps)}\n${after}`, "utf8");
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATHS: GenPaths = {
  rulePath: resolve(here, "../.claude-plugin/tea-rags/rules/language-compatibility.md"),
  readmePath: resolve(here, "../README.md"),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeArtifacts(DEFAULT_PATHS);
  console.log("✓ language-compatibility.md + README block regenerated from capability descriptors.");
}
