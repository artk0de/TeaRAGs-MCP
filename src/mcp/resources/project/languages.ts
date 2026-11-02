import type { CollectionEntry, IndexMetrics, IndexStatus, LanguageCapability } from "../../../core/api/public/index.js";
import { formatResolveRate } from "../../../core/api/public/project-format.js";

export type CodegraphResolve = NonNullable<IndexStatus["codegraphResolve"]>;

/**
 * The effective env of the LAST INDEXING RUN, not the current process's.
 * `tuning` is the pre-9vpnz legacy shape, read only when `env` is absent.
 * Every consumer reads the snapshot through here so no digest line can drift
 * onto `process.env` and report a window the stored data was never built with.
 */
export function registryEnv(entry: CollectionEntry): Record<string, string> {
  return entry.env ?? entry.tuning ?? {};
}

// Chunker artifacts that aren't real programming languages (markdown code blocks,
// misclassified extensions). Drop them from the polyglot list to keep the digest signal-clean.
const POLYGLOT_BLACKLIST = new Set(["code", "bash", "text", "gitignore", "powershell", "ts", "yaml", "json"]);

export function sortedLanguages(metrics: IndexMetrics | null): string[] {
  if (!metrics?.distributions?.language) return [];
  return Object.entries(metrics.distributions.language)
    .filter(([lang]) => !POLYGLOT_BLACKLIST.has(lang))
    .sort(([, a], [, b]) => b - a)
    .map(([lang]) => lang);
}

/**
 * Languages ordered by chunk count, and the PRIMARY ones among them. A language
 * is primary when the metrics carry its per-language signal bucket: the stats
 * layer admits a code language only at >= MIN_LANGUAGE_SHARE of the chunks, so
 * this reuses that one policy instead of re-cutting shares — a Rails + TS
 * monolith gets both. `IndexStatus.languages` is never populated; not read.
 */
export function languageSplit(metrics: IndexMetrics | null): {
  languages: string[];
  primaries: string[];
  thresholdLanguages: string[];
} {
  const languages = sortedLanguages(metrics);
  const signals = metrics?.signals ?? {};
  const thresholdLanguages = languages.filter((language) => signals[language]);
  const primaries = thresholdLanguages.length > 0 ? thresholdLanguages : languages.slice(0, 1);
  return { languages, primaries, thresholdLanguages };
}

/**
 * `## Language capability` (bd tea-rags-mcp-xip6g) — the per-index projection
 * of the static language-compatibility matrix: one line per language THIS index
 * holds, its ceiling tiers read from the descriptors, paired with the realized
 * resolve rate where the index measured one. The cascade rule owns what a tier
 * means and how to act on a low rate; this section owns only which tiers and
 * rates apply here. Unmeasured languages with identical tiers share one line —
 * the digest is read every session.
 */
export function formatLanguageCapabilitySection(
  languages: readonly string[],
  primaries: readonly string[],
  capabilities: ReadonlyMap<string, LanguageCapability> | undefined,
  resolve: CodegraphResolve | undefined,
): string[] {
  if (!capabilities) return [];
  const rates = realizedResolveRates(primaries, resolve);
  const rows: { languages: string[]; tiers: string; rate?: RealizedResolveRate }[] = [];
  for (const language of languages) {
    const capability = capabilities.get(language);
    if (!capability) continue;
    const tiers = formatCapabilityTiers(capability);
    // A rate on a language with no call graph would be another language's number.
    const rate = capability.codegraph.tier === "none" ? undefined : rates.get(language);
    const shared = rate === undefined ? rows.find((row) => row.rate === undefined && row.tiers === tiers) : undefined;
    if (shared) {
      shared.languages.push(language);
    } else {
      rows.push({ languages: [language], tiers, rate });
    }
  }
  if (rows.length === 0) return [];
  return [
    "## Language capability — ceiling tier · realized resolve",
    ...rows.map(
      (row) =>
        `${row.languages.join(", ")}: ${row.tiers}${
          row.rate === undefined ? "" : ` · resolve ${renderRecallWithModel(row.rate, resolve?.modelResolution)}`
        }`,
    ),
  ];
}

function formatCapabilityTiers(capability: LanguageCapability): string {
  const { tier } = capability.codegraph;
  const codegraph =
    typeof tier === "string"
      ? tier
      : Object.entries(tier)
          .map(([typing, typingTier]) => `${typing} ${typingTier}`)
          .join(" / ");
  return `ast ${capability.ast.tier} · tests ${capability.tests.tier} · codegraph ${codegraph}`;
}

/**
 * Realized recall per language. `summarizeCodegraphResolve` drops `byLanguage`
 * when a single language survives its share cut, so an unsplit rate belongs to
 * the index's one primary language; with several primaries it cannot be
 * attributed and is left to `## Codegraph resolve` alone.
 */
function realizedResolveRates(
  primaries: readonly string[],
  resolve: CodegraphResolve | undefined,
): Map<string, RealizedResolveRate> {
  const rates = new Map<string, RealizedResolveRate>();
  if (!resolve) return rates;
  const byLanguage = resolve.byLanguage ?? [];
  for (const row of byLanguage) rates.set(row.language, realizedRateOf(row));
  const [primary] = primaries;
  if (byLanguage.length === 0 && primaries.length === 1 && primary !== undefined) {
    rates.set(primary, realizedRateOf(resolve));
  }
  return rates;
}

/**
 * A realized recall and, when a model raised it, the static floor and the
 * model-resolved sites behind it (bd tea-rags-mcp-2m83f.38).
 */
interface RealizedResolveRate {
  recall: number | null;
  staticRecall?: number | null;
  modelSites?: number;
  /** Sites the model put outside the project (bd tea-rags-mcp-2m83f.45). */
  externalSites?: number;
}

function realizedRateOf(row: {
  inProjectEdgeRecall: number | null;
  staticInProjectEdgeRecall?: number | null;
  callsResolvedByModel?: number;
  callsExternalByModel?: number;
}): RealizedResolveRate {
  return {
    recall: row.inProjectEdgeRecall,
    ...(row.staticInProjectEdgeRecall === undefined ? {} : { staticRecall: row.staticInProjectEdgeRecall }),
    ...(row.callsResolvedByModel === undefined ? {} : { modelSites: row.callsResolvedByModel }),
    ...(row.callsExternalByModel === undefined ? {} : { externalSites: row.callsExternalByModel }),
  };
}

/**
 * `0.92 (static 0.91 · model 117 sites · external 340, kev p>=0.7)` — the
 * combined recall, then the static floor, the model-resolved sites and the sites
 * the model put outside the project when a model moved it; the bare recall otherwise.
 */
function renderRecallWithModel(rate: RealizedResolveRate, models: CodegraphResolve["modelResolution"]): string {
  const recall = renderRecall(rate.recall);
  const modelSites = rate.modelSites ?? 0;
  const externalSites = rate.externalSites ?? 0;
  if (modelSites === 0 && externalSites === 0) return recall;
  const modelNames = (models ?? [])
    .map((m) => (m.threshold === undefined ? m.model : `${m.model} p>=${m.threshold}`))
    .join(" / ");
  const staticPart = rate.staticRecall === undefined ? "" : `static ${renderRecall(rate.staticRecall)} · `;
  const externalPart = externalSites === 0 ? "" : ` · external ${externalSites}`;
  return `${recall} (${staticPart}model ${modelSites} sites${externalPart}${modelNames === "" ? "" : `, ${modelNames}`})`;
}

export function roundTwo(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A recall shown without counters. `null` is the DTO's "nothing scored" value
 * (bd tea-rags-mcp-stpvj) and renders the shared marker; a scored 0 stays `0`.
 */
function renderRecall(rate: number | null): string {
  return formatResolveRate(rate, (r) => `${roundTwo(r)}`);
}

/**
 * Default form: `resolve rate: typescript 0.99 · ruby 0.89` plus one plain
 * warning per language carrying unnarrowed entry calls.
 *
 * Reads `inProjectEdgeRecall`, not `resolveSuccessRate`: outside DEBUG
 * `summarizeCodegraphResolve` omits `resolveSuccessRate` and every
 * `byReceiverKind`, while recall is always present (and equals
 * `resolveSuccessRate` since cai0.2). A summary exists only when run stats
 * exist, so there is always a rate line to render.
 */
export function formatResolvePlain(resolve: CodegraphResolve): string[] {
  const languages = resolve.byLanguage ?? [];
  const models = resolve.modelResolution;
  const rate =
    languages.length > 0
      ? languages.map((l) => `${l.language} ${renderRecallWithModel(realizedRateOf(l), models)}`).join(" · ")
      : renderRecallWithModel(realizedRateOf(resolve), models);
  const lines = ["## Codegraph resolve", `resolve rate: ${rate}`, ...formatResolveWarnings(resolve)];
  const paramTyped = resolve.callsParamTyped ?? 0;
  if (paramTyped > 0) lines.push(`paramTyped: ${paramTyped} calls resolved on a parameter typed by its callers`);
  const schemaAttribute = resolve.callsSchemaAttribute ?? 0;
  if (schemaAttribute > 0) {
    lines.push(`schemaAttribute: ${schemaAttribute} residual calls read a schema column (no in-project def)`);
  }
  const narrowed = formatNarrowedLine(resolve);
  if (narrowed !== null) lines.push(narrowed);
  return lines;
}

/**
 * Plain counterpart of the DEBUG ⚠ line (bd tea-rags-mcp-znxg8): one warning per
 * language carrying unnarrowed entry calls. The reader needs the consequence —
 * get_callers misses callers of those services — and the workaround, not the
 * receiver-kind mechanics behind the count.
 */
export function formatResolveWarnings(resolve: CodegraphResolve): string[] {
  const languages = resolve.byLanguage ?? [];
  if (languages.length === 0) {
    const unnarrowed = resolve.callsUnnarrowedTemplate ?? 0;
    return unnarrowed > 0 ? [formatUnnarrowedWarning("", unnarrowed)] : [];
  }
  return languages
    .filter((l) => (l.callsUnnarrowedTemplate ?? 0) > 0)
    .map((l) => formatUnnarrowedWarning(`${l.language}: `, l.callsUnnarrowedTemplate ?? 0));
}

/** Residual sites receiver narrowing settled statically (bd tea-rags-mcp-2m83f.43); `null` before any. */
function formatNarrowedLine(resolve: CodegraphResolve): string | null {
  const narrowed = resolve.callsNarrowed ?? 0;
  const empty = resolve.callsNarrowEmpty ?? 0;
  if (narrowed === 0 && empty === 0) return null;
  return `narrowed: ${narrowed} residual calls settled by their receiver's other calls, ${empty} matched no class`;
}

function formatUnnarrowedWarning(languagePrefix: string, unnarrowed: number): string {
  return (
    `⚠ ${languagePrefix}${unnarrowed} calls like \`Service.call(...)\` are linked to a shared base method, ` +
    "not the service itself — get_callers on those services misses callers. " +
    "Find usages with hybrid_search; persists after reindex → /tea-rags:report-issue"
  );
}
