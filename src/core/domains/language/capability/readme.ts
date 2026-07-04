import type { CodegraphTier, LanguageCapability, TypingTieredCodegraph } from "../../../contracts/types/language.js";
import { UNSUPPORTED_FALLBACK } from "./fallback.js";

/** Display order + human label (NOT the supported()/Map order). Also the stable
 *  secondary key: rows with an equal capability score keep this order. */
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

/**
 * Distinct moon phase per tier keyword — a fullness gradient (fuller = more
 * capable) so `full`≠`high` and `medium`≠`moderate` read apart at a glance.
 * `partial`/`low` deliberately share 🌒; every "absent" keyword shares 🌑.
 */
const TIER_MOON: Readonly<Record<string, string>> = {
  maximum: "🌕",
  full: "🌔",
  high: "🌖",
  medium: "🌓",
  moderate: "🌗",
  partial: "🌒",
  low: "🌒",
  minimal: "🌘",
  none: "🌑",
  na: "🌑",
  tbd: "🌑",
};

/** Display label for a tier keyword (`na`→`N/A`, `tbd`→`TBD`, else verbatim). */
const TIER_LABEL: Readonly<Record<string, string>> = { na: "N/A", tbd: "TBD" };

/** `<moon> **<label>**` badge for a tier keyword. */
function tierBadge(tier: string): string {
  return `${TIER_MOON[tier] ?? "🌑"} **${TIER_LABEL[tier] ?? tier}**`;
}

// ── Capability score (spec §2): codegraph*100 + ast*10 + tests, top-supported
//    first. Ruby's typing-tiered codegraph scores on its `untyped` tier. ──────
const AST_SCORE: Readonly<Record<string, number>> = { full: 2, partial: 1, none: 0 };
const TESTS_SCORE: Readonly<Record<string, number>> = { high: 3, medium: 2, low: 1, na: 0 };
const CODEGRAPH_SCORE: Readonly<Record<string, number>> = { maximum: 4, high: 3, moderate: 2, minimal: 1, none: 0 };

function isTypingTiered(tier: CodegraphTier | TypingTieredCodegraph): tier is TypingTieredCodegraph {
  return typeof tier === "object";
}

function codegraphScore(tier: CodegraphTier | TypingTieredCodegraph): number {
  return CODEGRAPH_SCORE[isTypingTiered(tier) ? tier.untyped : tier] ?? 0;
}

function capabilityScore(cap: LanguageCapability): number {
  return (
    codegraphScore(cap.codegraph.tier) * 100 + (AST_SCORE[cap.ast.tier] ?? 0) * 10 + (TESTS_SCORE[cap.tests.tier] ?? 0)
  );
}

function astCell(cap: LanguageCapability): string {
  const shorts = cap.ast.hooks?.length ? ` (${cap.ast.hooks.map((h) => h.short).join(", ")})` : "";
  return `${tierBadge(cap.ast.tier)} · ${cap.ast.engine}${shorts}`;
}

function testsCell(cap: LanguageCapability): string {
  const label = cap.tests.tech === "—" ? cap.tests.detection : cap.tests.tech;
  return `${tierBadge(cap.tests.tier)} · ${label}`;
}

function codegraphCell(cap: LanguageCapability): string {
  const { tier } = cap.codegraph;
  const tierStr = isTypingTiered(tier)
    ? `untyped ${tierBadge(tier.untyped)} · YARD ${tierBadge(tier.yard)} · RBS/Sorbet ${tierBadge(tier["rbs/sorbet"])}`
    : tierBadge(tier);
  return `${tierStr} — ${cap.codegraph.tech}`;
}

function row(cap: LanguageCapability, name: string): string {
  return `| ***${name}*** | ${astCell(cap)} | ${testsCell(cap)} | ${codegraphCell(cap)} |`;
}

function getOrThrow(caps: Map<string, LanguageCapability>, key: string): LanguageCapability {
  const cap = caps.get(key);
  if (!cap) throw new Error(`renderReadme: missing capability descriptor for "${key}"`);
  return cap;
}

/**
 * Render the human-facing README "Languages Compatibilities" section — a
 * collapsed `<details>` spoiler with a capability-ranked, moon-badged table.
 * Rows sort by `capabilityScore` desc (ties keep DISPLAY order via the stable
 * sort); the unsupported CharacterChunker fallback languages always trail. The
 * returned content is the inner block; the generator wraps it in the
 * `<!-- BEGIN/END lang-compat -->` markers.
 */
export function renderReadme(caps: Map<string, LanguageCapability>): string {
  const rows = [...DISPLAY]
    .map(([key, name]) => ({ name, cap: getOrThrow(caps, key) }))
    .sort((a, b) => capabilityScore(b.cap) - capabilityScore(a.cap))
    .map(({ cap, name }) => row(cap, name))
    .join("\n");
  const fallbackRows = UNSUPPORTED_FALLBACK.map(
    (f) => `| ***${f.language}*** | 🌑 **none** · CharacterChunker | 🌑 **N/A** | 🌑 **none** |`,
  ).join("\n");

  return `## Languages Compatibilities

<!-- markdownlint-disable MD033 -->
<details>
<summary>🌗 Supported languages & support levels</summary>

**Support:** 🌕 maximum · 🌔 full · 🌖 high · 🌓 medium · 🌗 moderate · 🌒 partial/low · 🌘 minimal · 🌑 none

What tea-rags supports per language and at what level. \`AST chunking\` is how
source is split into searchable chunks; \`Test chunking\` is how faithfully test
structure is preserved; \`Codegraph\` is the call-graph resolution ceiling (the
realized per-project number lives in the \`tea-rags prime\` digest, not here).
Rows are ordered by overall capability, richest support first.

| Language | AST chunking | Test chunking | Codegraph |
| --- | --- | --- | --- |
${rows}
${fallbackRows}

</details>
<!-- markdownlint-enable MD033 -->`;
}
