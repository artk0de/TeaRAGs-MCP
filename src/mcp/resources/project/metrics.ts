import { formatResolveRateCell, resolveRateMiss, type CollectionEntry } from "../../../core/api/public/index.js";
import {
  formatLanguageCapabilitySection,
  formatResolvePlain,
  languageSplit,
  registryEnv,
  roundTwo,
  type CodegraphResolve,
} from "./languages.js";
import type { ProjectDigestData, ProjectMetricsQuery } from "./types.js";

type CodegraphResolveKindRow = NonNullable<CodegraphResolve["byReceiverKind"]>[number];
type SignalScope = { labelMap: Record<string, number>; format?: "percent" | "percent100" };
type LanguageSignals = Record<string, Record<string, SignalScope>>;

/** Every section the metrics resource renders, in output order. */
export const PROJECT_METRICS_SECTIONS = ["thresholds", "labelMap", "capability", "resolve", "registry"] as const;

/**
 * The project's reference numbers: per-language signal thresholds and label
 * maps, capability tiers, the codegraph resolve tally and the registry params.
 * `language` narrows to one language (default: every primary); `section`
 * picks sections (default: all).
 */
export function formatProjectMetrics(data: ProjectDigestData, query: ProjectMetricsQuery): string {
  const sections = new Set(query.section && query.section.length > 0 ? query.section : PROJECT_METRICS_SECTIONS);
  const { languages, primaries } = languageSplit(data.metrics);
  const selected = query.language ? [query.language] : primaries;
  const signals = (data.metrics?.signals ?? {}) as Record<string, LanguageSignals>;
  const blocks: string[][] = [[`# tea-rags metrics — ${data.projectName ?? data.path}`]];

  if (sections.has("thresholds")) {
    for (const language of selected) {
      const bucket = signals[language];
      blocks.push(bucket ? formatThresholdsSection(language, bucket) : [`no per-language thresholds for ${language}`]);
    }
  }
  if (sections.has("labelMap")) {
    for (const language of selected) {
      const bucket = signals[language];
      blocks.push(bucket ? formatLabelMapSection(language, bucket) : [`no per-language label maps for ${language}`]);
    }
  }
  if (sections.has("capability")) {
    const shown = query.language ? selected : languages;
    const capability = formatLanguageCapabilitySection(
      shown,
      primaries,
      data.languageCapabilities,
      data.status.codegraphResolve,
    );
    if (capability.length > 0) blocks.push(capability);
  }
  const resolve = data.status.codegraphResolve;
  if (sections.has("resolve") && resolve) {
    blocks.push([...formatResolvePlain(resolve), ...formatResolveBreakdown(resolve).slice(1)]);
  }
  if (sections.has("registry") && data.registry) {
    const registry = formatRegistryParamsLine(data.registry);
    if (registry !== null) blocks.push([registry]);
  }
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

function formatThresholdsSection(language: string, signals: LanguageSignals): string[] {
  // One table row per signal: label names once, then bounds. Exact label names
  // are preserved — they must match the labels a ranking overlay renders.
  const lines = [
    `## Signal thresholds — ${language}`,
    "",
    'Bands low→high; numbers = lower bound of each band from the 2nd on (1st band = below the 2nd). test "=src" = same as source.',
    "| signal | bands | source ≥ | test ≥ |",
    "|---|---|---|---|",
  ];
  for (const [signalName, scopes] of Object.entries(signals)) {
    const labels = Object.keys((scopes.source ?? scopes.test)?.labelMap ?? {});
    const source = scopes.source ? formatBandBounds(scopes.source) : "—";
    lines.push(
      `| ${signalName} | ${labels.join("/")} | ${source} | ${formatTestBounds(scopes.test, labels, source)} |`,
    );
  }
  return lines;
}

/** Lossless `label <x / label ≥y` form per signal and scope. */
function formatLabelMapSection(language: string, signals: LanguageSignals): string[] {
  const lines = [`## Label maps — ${language}`];
  for (const [signalName, scopes] of Object.entries(signals)) {
    const parts = Object.entries(scopes).map(
      ([scopeName, scope]) => `${scopeName} ${formatLabelMap(scope.labelMap, scope.format)}`,
    );
    lines.push(`${signalName}: ${parts.join(" · ")}`);
  }
  return lines;
}

/** Lower bounds of the 2nd band on; a lone band catches every value. */
function formatBandBounds(scope: SignalScope): string {
  const bounds = Object.values(scope.labelMap).slice(1);
  if (bounds.length === 0) return "any";
  return bounds.map((threshold) => formatThreshold(threshold, scope.format)).join(" / ");
}

// Test bands share the row's label column only when their labels match; a
// different label set keeps the full `label <x / label ≥y` form, lossless.
function formatTestBounds(test: SignalScope | undefined, labels: string[], source: string): string {
  if (!test) return "—";
  if (Object.keys(test.labelMap).join("/") !== labels.join("/")) return formatLabelMap(test.labelMap, test.format);
  const bounds = formatBandBounds(test);
  return bounds === source && source !== "—" ? "=src" : bounds;
}

// A threshold is the LOWEST value that reaches its band: the resolver keeps the
// last band the value has reached. Bands arrive ascending and stripped of
// unreachable ones, so each carries its own lower bound; only the first band has
// an upper bound to show — it is the default for everything below the second.
function formatLabelMap(labelMap: Record<string, number>, format?: "percent" | "percent100"): string {
  const bands = Object.entries(labelMap);
  const [, secondThreshold] = bands[1] ?? [];
  return bands
    .map(([label, threshold], index) => {
      if (index > 0) return `${label} ≥${formatThreshold(threshold, format)}`;
      // A lone band catches every value — no bound to state.
      return secondThreshold === undefined ? label : `${label} <${formatThreshold(secondThreshold, format)}`;
    })
    .join(" / ");
}

// Percent display hints (value stays raw upstream):
//  • "percent"    — fraction ∈ [0,1] → ×100 + "%" (e.g. codegraph.chunk.pageRank).
//  • "percent100" — already a 0–100 percentage → suffix "%" only (e.g. git.*.bugFixRate).
function formatThreshold(threshold: number, format?: "percent" | "percent100"): string {
  if (format === "percent") return `${roundTwo(threshold * 100)}%`;
  if (format === "percent100") return `${roundTwo(threshold)}%`;
  return `${roundTwo(threshold)}`;
}

/**
 * tea-rags-mcp-32cnc — ONE compact line with the effective per-project params
 * from the registry entry. Absent fields are omitted; the env snapshot appends
 * as key-sorted `key=value` pairs.
 */
function formatRegistryParamsLine(entry: CollectionEntry): string | null {
  const parts: string[] = [];
  if (entry.embeddingBaseUrl) {
    const fallback = entry.embeddingFallbackUrl ? ` (fallback ${entry.embeddingFallbackUrl})` : "";
    parts.push(`embedding ${entry.embeddingBaseUrl}${fallback}`);
  } else if (entry.embeddingFallbackUrl) {
    // Fallback recorded without a base URL — registry.json is hand-editable.
    parts.push(`embedding fallback ${entry.embeddingFallbackUrl}`);
  }
  if (entry.qdrantUrl === "embedded") {
    // Sentinel persistence (2nfdm): the registry stores "embedded", never the daemon's port URL.
    parts.push("qdrant embedded");
  } else if (entry.qdrantUrl) {
    parts.push(`qdrant ${entry.qdrantUrl}${entry.qdrantEmbedded ? " (embedded)" : ""}`);
  }
  if (entry.codegraphEnabled !== undefined) {
    parts.push(`codegraph ${entry.codegraphEnabled ? "on" : "off"}`);
  }
  if (entry.teaRagsVersion) {
    parts.push(`v${entry.teaRagsVersion}`);
  }
  const envSnapshot = Object.entries(registryEnv(entry))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  if (envSnapshot) {
    parts.push(envSnapshot);
  }
  return parts.length > 0 ? `registry: ${parts.join(" · ")}` : null;
}

/** Model-resolved sites no receiver-kind row carries, or `null` when none. */
function formatUnlabeledModelSites(resolve: CodegraphResolve): string | null {
  const unlabeled = resolve.callsResolvedByModelUnlabeled ?? 0;
  if (unlabeled === 0) return null;
  return `${unlabeled} model-resolved sites predate migration 055 — in no receiver-kind row; a reindex labels them`;
}

/**
 * tea-rags-mcp-7m5xz — the per-receiver-kind breakdown, present only when the
 * producer built it (DEBUG). A top-level `byReceiverKind` renders flat; nested
 * `byLanguage` rows render each kind indented under its language.
 */
function formatResolveBreakdown(resolve: CodegraphResolve): string[] {
  const hasTopKinds = (resolve.byReceiverKind?.length ?? 0) > 0;
  const langsWithKinds = (resolve.byLanguage ?? []).filter((l) => (l.byReceiverKind?.length ?? 0) > 0);
  const unnarrowed = resolve.callsUnnarrowedTemplate ?? 0;
  if (!hasTopKinds && langsWithKinds.length === 0 && unnarrowed === 0) return [];

  const lines = ["## Codegraph resolve"];
  const unlabeled = formatUnlabeledModelSites(resolve);
  if (unlabeled !== null) lines.push(unlabeled);
  if (hasTopKinds) {
    for (const k of resolve.byReceiverKind ?? []) lines.push(formatResolveKind(k));
  } else {
    for (const l of langsWithKinds) {
      lines.push(`${l.language}:`);
      for (const k of l.byReceiverKind ?? []) lines.push(`  ${formatResolveKind(k)}`);
    }
  }
  // bd tea-rags-mcp-znxg8 — non-zero only: those calls RESOLVED onto the shared
  // template, so recall reads 1.0 while the concrete services' callers go missing.
  if (unnarrowed > 0) {
    lines.push(
      `⚠ ${unnarrowed} constant-receiver entry call(s) resolved to a shared self-dispatch template instead of the concrete hook — recall rates cannot see this`,
    );
  }
  return lines;
}

/**
 * `selfMember 0.96 125/130` (kind · rate · resolved/attempted), with
 * ` · N unnarrowed` appended only when this bucket carries unnarrowed entry
 * calls (bd tea-rags-mcp-4vg1i).
 */
function formatResolveKind(k: CodegraphResolveKindRow): string {
  // bd tea-rags-mcp-qodqg — an empty denominator reports its rate as null; the
  // shared cell renders the "nothing to score" marker, counters kept.
  const miss = resolveRateMiss({
    attempted: k.attempted,
    resolved: k.resolved,
    externalSkipped: k.externalSkipped,
    unresolvable: k.unresolvable,
    noInProjectDef: k.callsNoInProjectDef,
    coreAmbiguous: k.callsCoreAmbiguous,
  });
  const cell = formatResolveRateCell({
    rate: k.resolveSuccessRate,
    denominator: k.resolved + miss,
    counters: `${k.resolved}/${k.attempted}`,
    renderRate: (rate) => `${roundTwo(rate)}`,
  });
  const resolvedByModel = k.resolvedByModel ?? 0;
  const base = `${k.receiverKind} ${cell}${resolvedByModel > 0 ? ` (model +${resolvedByModel})` : ""}`;
  const unnarrowed = k.callsUnnarrowedTemplate ?? 0;
  return unnarrowed > 0 ? `${base} · ${unnarrowed} unnarrowed` : base;
}
