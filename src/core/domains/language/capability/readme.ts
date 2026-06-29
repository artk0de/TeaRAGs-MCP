import type { CodegraphTier, LanguageCapability, TypingTieredCodegraph } from "../../../contracts/types/language.js";
import { UNSUPPORTED_FALLBACK } from "./fallback.js";

/** Display order + human label (NOT the supported()/Map order). */
const DISPLAY: readonly (readonly [string, string])[] = [
  ["typescript", "TypeScript"],
  ["javascript", "JavaScript"],
  ["python", "Python"],
  ["go", "Go"],
  ["java", "Java"],
  ["rust", "Rust"],
  ["ruby", "Ruby"],
  ["bash", "Bash"],
  ["markdown", "Markdown"],
];

function isTypingTiered(tier: CodegraphTier | TypingTieredCodegraph): tier is TypingTieredCodegraph {
  return typeof tier === "object";
}

function astHuman(cap: LanguageCapability): string {
  const hooks = cap.ast.hooks?.length ? ` (${cap.ast.hooks.join(", ")})` : "";
  return `${cap.ast.tier} · ${cap.ast.engine}${hooks}`;
}

function testsHuman(cap: LanguageCapability): string {
  const tier = cap.tests.tier === "na" ? "N/A" : cap.tests.tier;
  const label = cap.tests.tech === "—" ? cap.tests.detection : cap.tests.tech;
  return `${tier} · ${label}`;
}

function codegraphHuman(cap: LanguageCapability): string {
  const { tier } = cap.codegraph;
  const tierStr = isTypingTiered(tier)
    ? `untyped ${tier.untyped} · YARD ${tier.yard} · RBS/Sorbet ${tier["rbs/sorbet"] === "tbd" ? "TBD" : tier["rbs/sorbet"]}`
    : tier;
  return `${tierStr} — ${cap.codegraph.tech}`;
}

function row(cap: LanguageCapability, name: string): string {
  return `| ${name} | ${astHuman(cap)} | ${testsHuman(cap)} | ${codegraphHuman(cap)} |`;
}

function getOrThrow(caps: Map<string, LanguageCapability>, key: string): LanguageCapability {
  const cap = caps.get(key);
  if (!cap) throw new Error(`renderReadme: missing capability descriptor for "${key}"`);
  return cap;
}

/**
 * Render the human-facing README "Languages Compatibilities" section — a
 * collapsed `<details>` spoiler with a prose-rich table. Returned content is
 * the inner block; the generator wraps it in the `<!-- BEGIN/END lang-compat -->`
 * markers.
 */
export function renderReadme(caps: Map<string, LanguageCapability>): string {
  const rows = DISPLAY.map(([key, name]) => row(getOrThrow(caps, key), name)).join("\n");
  const fallbackRows = UNSUPPORTED_FALLBACK.map(
    (f) => `| ${f.language} | none · CharacterChunker | none | none |`,
  ).join("\n");

  return `## Languages Compatibilities

<!-- markdownlint-disable MD033 -->
<details>
<summary>Supported languages and support levels</summary>

What tea-rags supports per language and at what level. \`AST chunking\` is how
source is split into searchable chunks; \`Test chunking\` is how faithfully test
structure is preserved; \`Codegraph\` is the call-graph resolution ceiling (the
realized per-project number lives in the \`tea-rags prime\` digest, not here).

| Language | AST chunking | Test chunking | Codegraph |
| --- | --- | --- | --- |
${rows}
${fallbackRows}

</details>
<!-- markdownlint-enable MD033 -->`;
}
