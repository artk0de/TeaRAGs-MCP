import type { CollectionMemoryBytes, CollectionMemoryMetrics } from "../../core/api/public/dto/collection.js";
import type { IndexStatus } from "../../core/api/public/dto/ingest.js";
import type { IndexMetrics } from "../../core/api/public/dto/metrics.js";
import { formatForPrime } from "../update-check/format.js";
import type { PrimeData, PrimeFailureReason, PrimeRegistryEntry } from "./types.js";

type InfraHealth = NonNullable<IndexStatus["infraHealth"]>;
type EnrichmentMap = NonNullable<IndexStatus["enrichment"]>;
type CodegraphResolve = NonNullable<IndexStatus["codegraphResolve"]>;
type CodegraphResolveKindRow = NonNullable<CodegraphResolve["byReceiverKind"]>[number];

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * How to render, decided by the caller — kept off `PrimeData`, which carries
 * what the index holds.
 */
export interface PrimeFormatOptions {
  /** DEBUG — include developer measurement detail (codegraph receiver-kind breakdown). */
  debug?: boolean;
}

export function formatPrime(
  input: PrimeData | PrimeFailureReason,
  now: Date = new Date(),
  options: PrimeFormatOptions = {},
): string {
  if ("kind" in input) {
    return formatFailure(input);
  }
  return formatDigest(input, now, options.debug === true);
}

function formatFailure(reason: PrimeFailureReason): string {
  switch (reason.kind) {
    case "path-not-found":
      return `# tea-rags prime\nPath not found: ${reason.path}\n`;
    case "qdrant-cold":
      return (
        `# tea-rags prime — ${reason.path}\n` +
        `Qdrant warm-up pending — index queries will be available after MCP server attaches.\n`
      );
  }
}

function formatDigest(data: PrimeData, now: Date, debug: boolean): string {
  const lines: string[] = [];
  lines.push(`# tea-rags prime — ${data.path}`);
  lines.push("");
  lines.push("## Status");
  lines.push(formatStatusLine(data.status, now, data.memory ?? null));

  const registryParams = data.registry ? formatRegistryParamsLine(data.registry) : null;
  if (data.projectName || registryParams) {
    lines.push("");
    lines.push("## Project");
    if (data.projectName) {
      lines.push(`name: \`${data.projectName}\``);
    }
    if (registryParams) {
      lines.push(registryParams);
    }
    if (data.projectName) {
      lines.push(
        `[hint] Use \`project: "${data.projectName}"\` as the preferred parameter in MCP tool calls (over path / collection).`,
      );
    }
  }

  if (data.status.status !== "indexed") {
    return `${lines.join("\n")}\n`;
  }

  if (data.status.embeddingModel) {
    const sparse = data.status.sparseVersion !== undefined ? ` · sparse v${data.status.sparseVersion}` : "";
    lines.push(`embedding: ${data.status.embeddingModel}${sparse}`);
  }

  const staleness = computeStaleness(data.status.lastUpdated, now);
  if (staleness?.stale) {
    lines.push("");
    lines.push(
      `⚠ Index is stale (last updated ${staleness.ago} ago). ` +
        "Run `index_codebase` before the next tea-rags search/explore.",
    );
    // Stale + auto-update off → the one-line cure (hpg2). Verdict "disabled"
    // covers both a missing block and enabled=false.
    if (data.autoUpdateOutcome === "disabled" && data.projectName) {
      lines.push(`enable auto-update: \`tea-rags auto-update enable --project ${data.projectName}\``);
    }
  }

  const autoUpdateLine = formatAutoUpdateLine(data, now);
  if (autoUpdateLine !== null) {
    lines.push("");
    lines.push(autoUpdateLine);
  }

  lines.push("");
  lines.push("## Drift");
  lines.push(data.drift ?? "none");

  if (data.memory) {
    lines.push("");
    lines.push(...formatMemorySection(data.memory, debug));
  }

  if (data.status.infraHealth) {
    lines.push("");
    lines.push(...formatInfraSection(data.status.infraHealth));
  }

  if (data.status.enrichment) {
    lines.push("");
    lines.push(...formatEnrichmentSection(data.status.enrichment, data.registry ?? null));
  }

  // Languages are ordered by IndexMetrics.distributions.language chunk count.
  // IndexStatus.languages is declared but never populated by any producer — do
  // not use it. A language is PRIMARY when the metrics carry its per-language
  // signal bucket: the stats layer admits a code language only at
  // >= MIN_LANGUAGE_SHARE of the chunks, so the digest reuses that one policy
  // instead of re-cutting shares here — a Rails + TS monolith gets both.
  const languages = sortedLanguages(data.metrics);
  const signals = data.metrics?.signals ?? {};
  const thresholdLanguages = languages.filter((language) => signals[language]);
  const primaries = thresholdLanguages.length > 0 ? thresholdLanguages : languages.slice(0, 1);
  if (languages.length > 0) {
    lines.push("");
    lines.push(...formatLanguageSection(languages, primaries));
  }

  for (const language of thresholdLanguages) {
    lines.push("");
    lines.push(...formatThresholdsSection(language, signals[language]));
  }

  const resolveLines = formatCodegraphResolveSection(data.status.codegraphResolve, debug);
  if (resolveLines.length > 0) {
    lines.push("");
    lines.push(...resolveLines);
  }

  if (data.update !== null) {
    const updateLines = formatForPrime(data.update);
    if (updateLines.length > 0) {
      lines.push("");
      lines.push(...updateLines);
    }
  }

  lines.push("");
  lines.push('→ run `tea-rags prime "$CLAUDE_PROJECT_DIR"` to refresh this digest after re-indexing');

  return `${lines.join("\n")}\n`;
}

/**
 * tea-rags-mcp-32cnc — ONE compact line with the effective per-project params
 * from the registry entry, so a session immediately sees which env the CLI/MCP
 * will actually use (registry params ≠ the current shell's env — e.g. DEBUG is
 * a process env, not a registry param). Built generically from CollectionEntry
 * scalars: absent fields are omitted and the line always stays single. The
 * forward-compat `tuning` map (see PrimeRegistryEntry) appends as `key=value`
 * pairs, key-sorted for output stability.
 */
function formatRegistryParamsLine(entry: PrimeRegistryEntry): string | null {
  const parts: string[] = [];
  if (entry.embeddingBaseUrl) {
    const fallback = entry.embeddingFallbackUrl ? ` (fallback ${entry.embeddingFallbackUrl})` : "";
    parts.push(`embedding ${entry.embeddingBaseUrl}${fallback}`);
  } else if (entry.embeddingFallbackUrl) {
    // Defensive: fallback recorded without a base URL (should not happen via
    // the pipeline, but registry.json is hand-editable).
    parts.push(`embedding fallback ${entry.embeddingFallbackUrl}`);
  }
  if (entry.qdrantUrl === "embedded") {
    // Sentinel persistence (2nfdm): the registry stores "embedded", never the
    // daemon's ephemeral port URL — display it once, no redundant suffix.
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

/**
 * The effective env of the LAST INDEXING RUN, not the current process's.
 * `tuning` is the pre-9vpnz legacy shape, read only when `env` is absent.
 * Every consumer reads the snapshot through here so no digest line can drift
 * onto `process.env` and report a window the stored data was never built with.
 */
function registryEnv(entry: PrimeRegistryEntry): Record<string, string> {
  return entry.env ?? entry.tuning ?? {};
}

// Chunker artifacts that aren't real programming languages (markdown code blocks,
// misclassified extensions). Drop them from the polyglot list to keep the digest signal-clean.
const POLYGLOT_BLACKLIST = new Set(["code", "bash", "text", "gitignore", "powershell", "ts", "yaml", "json"]);

function sortedLanguages(metrics: IndexMetrics | null): string[] {
  if (!metrics?.distributions?.language) return [];
  return Object.entries(metrics.distributions.language)
    .filter(([lang]) => !POLYGLOT_BLACKLIST.has(lang))
    .sort(([, a], [, b]) => b - a)
    .map(([lang]) => lang);
}

function formatLanguageSection(languages: string[], primaries: string[]): string[] {
  if (languages.length === 1) {
    return ["## Language", languages[0]];
  }
  const rest = languages.filter((language) => !primaries.includes(language));
  if (rest.length === 0) {
    return ["## Polyglot", `primary: ${primaries.join(", ")}`];
  }
  return [
    "## Polyglot",
    `primary: ${primaries.join(", ")} · also: ${rest.join(", ")}`,
    "→ for non-primary languages, call `get_index_metrics` for their labelMap",
  ];
}

function formatThresholdsSection(
  language: string,
  signals: Record<string, Record<string, { labelMap: Record<string, number>; format?: "percent" | "percent100" }>>,
): string[] {
  const lines = [`## Signal thresholds — ${language}`, ""];
  // One line per signal (source + test on the same line) to keep the digest
  // resident-cheap. Exact label names are preserved — they must match the
  // labels rendered in a ranking overlay for the agent to map them to a band.
  for (const [signalName, scopes] of Object.entries(signals)) {
    const source = scopes.source ? formatLabelMap(scopes.source.labelMap, scopes.source.format) : "—";
    const testRaw = scopes.test ? formatLabelMap(scopes.test.labelMap, scopes.test.format) : "—";
    // Lossless back-ref: when test bands are byte-identical to source, collapse
    // to "=src" instead of repeating the full band list (common for signals
    // whose source/test percentiles coincide, e.g. blameDominantAuthorPct).
    const test = testRaw === source && source !== "—" ? "=src" : testRaw;
    lines.push(`- **${signalName}** — source: ${source} · test: ${test}`);
  }
  return lines;
}

// A threshold is the LOWEST value that reaches its band, not the highest the
// band admits: the resolver keeps the last band the value has reached. Rendering
// `label ≤threshold` inverted every band in the digest — `healthy ≤0%` read as
// "healthy only at exactly 0%" when it meant "healthy below the next band", and
// that misreading cost a full debugging session. Bands arrive ascending and
// already stripped of unreachable ones (`resolvableLabelBands`), so each carries
// its own lower bound; only the first band has an upper bound to show, because
// it is the default for everything below the second.
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
//  • "percent"    — fraction ∈ [0,1] → ×100 + "%" (e.g. codegraph.chunk.pageRank,
//    whose sub-0.01 percentiles would otherwise round to "≤0").
//  • "percent100" — already a 0–100 percentage → suffix "%" only, no scaling
//    (e.g. git.*.bugFixRate).
function formatThreshold(threshold: number, format?: "percent" | "percent100"): string {
  if (format === "percent") return `${roundTwo(threshold * 100)}%`;
  if (format === "percent100") return `${roundTwo(threshold)}%`;
  return `${roundTwo(threshold)}`;
}

function roundTwo(n: number): number {
  return Math.round(n * 100) / 100;
}

// Local to the prime digest layer: the MCP tool layer (register-status-tools)
// owns its own formatBytes. They cannot share one helper without exporting a
// presentation util through core/api/public (cli reaches core only via that
// barrel, mcp likewise) — over-placing a UI helper into the domain core. Two
// small renderers in two bounded presentation contexts is the layer-correct call.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatStatusLine(status: IndexStatus, now: Date, memory: CollectionMemoryMetrics | null): string {
  switch (status.status) {
    case "not_indexed":
      return "not indexed. Run `/tea-rags:index` to index this codebase.";
    case "stale_indexing":
      return (
        "stale indexing marker (previous run crashed). " +
        "Re-run /tea-rags:index — stale collection will be cleaned up."
      );
    case "indexing":
      return `indexing in progress (${status.chunksCount ?? 0} chunks so far). Re-prime after completion.`;
    case "indexed": {
      const collection = `\`${status.collectionName ?? "unknown"}\``;
      const counts =
        status.filesCount !== undefined
          ? `${status.filesCount} files / ${status.chunksCount ?? 0} chunks`
          : `${status.chunksCount ?? 0} chunks`;
      const qdrant = status.infraHealth?.qdrant;
      const size = formatSizeFigure(qdrant?.indexSizeBytes, memory);
      const quant =
        qdrant?.quantization !== undefined
          ? ` · ${qdrant.quantization === "turbo" ? "turbo (8x)" : qdrant.quantization} quant`
          : "";
      const base = `indexed · collection ${collection} · ${counts}${size}${quant}`;
      const staleness = computeStaleness(status.lastUpdated, now);
      return staleness ? `${base} · last indexed: ${staleness.ago} ago` : base;
    }
    case "unavailable":
      return "index unavailable.";
  }
}

/**
 * The digest's ONE disk figure (bd tea-rags-mcp-h4iy). Two measures exist and
 * disagree by design: the allocated blocks tea-rags sums over the embedded
 * storage dir (what the disk actually loses, what `du` reports) and the file
 * sizes in the server's memory report, which count Qdrant's sparsely
 * preallocated mmap space — 1.2 GB vs 2.07 GB on the self-index. Allocated wins
 * whenever it exists; file sizes stand in only where tea-rags cannot see the
 * disk (external Qdrant), labelled `apparent size` so they never read as the
 * same quantity.
 */
function formatSizeFigure(indexSizeBytes: number | undefined, memory: CollectionMemoryMetrics | null): string {
  if (indexSizeBytes !== undefined) return ` · ${formatBytes(indexSizeBytes)} on disk`;
  if (memory) return ` · ${formatBytes(memory.total.apparentDiskBytes)} apparent size`;
  return "";
}

/** Payload field indexes listed by name under DEBUG — the rest collapse into `+N more`. */
const MEMORY_TOP_PAYLOAD_INDEXES = 5;

/**
 * `## Memory` — the server's memory report. Default: one line of collection
 * totals, RAM (heap, not evictable) and page cache (evictable mmap pages) against
 * what the server wants cached. DEBUG adds the per-component breakdown in the
 * report's own unit, file size, labelled apparent: its rows sum above the Status
 * line's on-disk figure, and the note says why rather than printing a second
 * total.
 */
function formatMemorySection(memory: CollectionMemoryMetrics, debug: boolean): string[] {
  const { ramBytes, cachedBytes, expectedCacheBytes } = memory.total;
  const wanted = expectedCacheBytes > 0 ? ` / ${formatBytes(expectedCacheBytes)} wanted` : "";
  const lines = ["## Memory", `RAM ${formatBytes(ramBytes)} · page cache ${formatBytes(cachedBytes)}${wanted}`];
  if (!debug) return lines;

  lines.push(
    "per component — apparent size / RAM / page cache (apparent counts preallocated mmap space, sums above on-disk):",
  );
  for (const vector of memory.vectors) {
    // Tea-rags names the dense vector "dense" on hybrid collections; the
    // unnamed default vector of a dense-only collection is the same thing.
    const name = vector.name || "dense";
    lines.push(formatMemoryRow(`${name} storage`, vector.storage));
    lines.push(formatMemoryRow(`${name} index`, vector.index));
    if (vector.quantized) lines.push(formatMemoryRow(`${name} quantized`, vector.quantized));
  }
  for (const sparse of memory.sparseVectors) {
    const name = sparse.name ? `sparse ${sparse.name}` : "sparse";
    lines.push(formatMemoryRow(`${name} storage`, sparse.storage));
    lines.push(formatMemoryRow(`${name} index`, sparse.index));
  }
  lines.push(formatMemoryRow("payload", memory.payload));
  const { payloadIndexes } = memory;
  lines.push(formatMemoryRow(`payload indexes (${payloadIndexes.count})`, payloadIndexes.total));
  const listed = payloadIndexes.byField.slice(0, MEMORY_TOP_PAYLOAD_INDEXES);
  for (const index of listed) lines.push(`  ${formatMemoryRow(index.field, index.bytes)}`);
  const unlisted = payloadIndexes.count - listed.length;
  if (unlisted > 0) lines.push(`  - +${unlisted} more`);
  lines.push(formatMemoryRow("other", memory.other));
  return lines;
}

function formatMemoryRow(label: string, bytes: CollectionMemoryBytes): string {
  return `- ${label}: ${formatBytes(bytes.apparentDiskBytes)} / ${formatBytes(bytes.ramBytes)} / ${formatBytes(bytes.cachedBytes)}`;
}

/**
 * Auto-update digest line (hpg2). Null = no line: trigger not fired, or
 * config disabled (the stale-block hint covers that case instead). A failed
 * lastRun dominates every fresh verdict — the operator must see the failure
 * and the log path before anything else.
 */
function formatAutoUpdateLine(data: PrimeData, now: Date): string | null {
  const outcome = data.autoUpdateOutcome;
  const config = data.registry?.autoUpdate;
  if (outcome === undefined || outcome === null || !config?.enabled) return null;

  const { lastRun } = config;
  if (lastRun?.outcome === "failed") {
    const ago = computeStaleness(new Date(lastRun.at), now)?.ago ?? "recently";
    return `auto-update: failed ${ago} ago — see ${data.autoUpdateLogPath ?? "the auto-update log"}`;
  }
  if (outcome === "eligible") {
    return `auto-update: on (${config.targetBranch}) · catching up in background`;
  }
  if (outcome === "branch-mismatch") {
    return `auto-update: paused — HEAD not on target ${config.targetBranch}; run \`index_codebase\` to switch the index`;
  }
  const lastRunSuffix =
    lastRun !== undefined
      ? ` · last run ${lastRun.outcome} ${computeStaleness(new Date(lastRun.at), now)?.ago ?? "just now"} ago`
      : "";
  return `auto-update: on (${config.targetBranch})${lastRunSuffix}`;
}

function computeStaleness(lastUpdated: Date | undefined, now: Date): { ago: string; stale: boolean } | null {
  if (!lastUpdated) return null;
  const diffMs = now.getTime() - new Date(lastUpdated).getTime();
  return { ago: formatRelativeTime(diffMs), stale: diffMs > STALE_THRESHOLD_MS };
}

function formatInfraSection(infra: InfraHealth): string[] {
  const lines = ["## Infra"];
  const q = infra.qdrant;
  let qLine = `qdrant: ${q.status ?? "unknown"} (optimizer ${q.optimizerStatus ?? "unknown"}) at ${q.url}`;
  if (q.version) {
    qLine += ` · v${q.version}`;
  }
  if (q.status === "yellow") {
    qLine += " — background optimization in progress";
  } else if (q.status === "red") {
    qLine += " — UNAVAILABLE, search will fail";
  }
  lines.push(qLine);

  const e = infra.embedding;
  const badge = (ok: boolean) => (ok ? "available" : "unavailable");
  if (e.url) {
    // Per-endpoint health: each ollama endpoint carries its OWN status badge,
    // not a single "active endpoint" availability. Primary badge falls back to
    // the overall `available` when the provider does not expose a dedicated
    // primary probe (non-ollama / legacy).
    const primary = ` · primary ${e.url} (${badge(e.primaryAvailable ?? e.available)})`;
    const fallback = e.fallbackUrl
      ? ` · fallback ${e.fallbackUrl} (${e.fallbackAvailable === undefined ? "unknown" : badge(e.fallbackAvailable)})`
      : "";
    lines.push(`embedding: ${e.provider}${primary}${fallback}`);

    // When both endpoints report down the snapshot may be lying: prime probes
    // health once at session start, so an embedding that recovered since reads
    // as "unavailable" here. Nudge the agent to confirm live before concluding
    // search is dead. `fallbackAvailable === false` already implies a fallback
    // exists and was probed (undefined = unknown → no nudge).
    const bothEndpointsDown = (e.primaryAvailable ?? e.available) === false && e.fallbackAvailable === false;
    if (bothEndpointsDown) {
      lines.push(
        "[hint] both embedding endpoints report unavailable — prime is a point-in-time snapshot; " +
          "call `get_index_status` for live infra health before assuming search is down.",
      );
    }
  } else {
    // Providers without a url (e.g. onnx): keep the legacy headline form.
    lines.push(`embedding: ${badge(e.available)} · ${e.provider}`);
  }
  return lines;
}

function formatEnrichmentSection(enrichment: EnrichmentMap, registry: PrimeRegistryEntry | null): string[] {
  const lines = ["## Enrichment"];
  for (const [provider, health] of Object.entries(enrichment)) {
    const inProgress = health.file.status === "in_progress" || health.chunk.status === "in_progress";
    const suffix = inProgress ? " (in progress)" : "";
    const windows = provider === "git" ? formatGitWalkWindows(registry) : "";
    lines.push(`${provider}: file ${health.file.status}, chunk ${health.chunk.status}${suffix}${windows}`);
  }
  return lines;
}

/** Env keys carrying each git walk's horizon, paired with the level it bounds. */
const GIT_WALK_WINDOW_KEYS: readonly (readonly [level: string, envKey: string])[] = [
  ["file", "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS"],
  ["chunk", "TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS"],
];

/**
 * The two git walks read DIFFERENT horizons — 12 months of `git log` for file
 * signals, 6 of the commit walk for chunk signals — and both windows SLIDE, so
 * a chunk-level zero accrues on its own as the older half of a file's history
 * leaves the window. Without the horizons in sight, an operator comparing two
 * runs' aggregates reads that accrual as a regression; the digest already
 * carries both numbers, buried in the registry env wall, so this only makes
 * them legible on the row they govern.
 *
 * Read from the registry snapshot, never `process.env`: the question the reader
 * has is what the INDEXED data was built with, and a session that exported a
 * new value has not rebuilt anything. A key the snapshot omits renders nothing
 * — a default printed here would be a claim about data nobody measured.
 */
function formatGitWalkWindows(registry: PrimeRegistryEntry | null): string {
  if (!registry) return "";
  const env = registryEnv(registry);
  const declared = GIT_WALK_WINDOW_KEYS.filter(([, envKey]) => env[envKey] !== undefined).map(
    ([level, envKey]) => `${level} ${env[envKey]}mo`,
  );
  return declared.length > 0 ? ` · window ${declared.join(" / ")}` : "";
}

/**
 * `## Codegraph resolve` — two audiences, two forms, one flag. The SessionStart
 * digest is read by agents and users who cannot act on receiver-kind buckets or
 * resolved/attempted counts, so by default it shows only per-language recall and
 * a plain warning naming what breaks. Developers measuring resolver work run
 * `DEBUG=1 tea-rags prime` for the full breakdown — the same flag the producer
 * uses to decide whether it builds that breakdown at all.
 */
function formatCodegraphResolveSection(resolve: CodegraphResolve | undefined, debug: boolean): string[] {
  if (!resolve) return [];
  return debug ? formatResolveBreakdown(resolve) : formatResolvePlain(resolve);
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
function formatResolvePlain(resolve: CodegraphResolve): string[] {
  const languages = resolve.byLanguage ?? [];
  const rate =
    languages.length > 0
      ? languages.map((l) => `${l.language} ${roundTwo(l.inProjectEdgeRecall)}`).join(" · ")
      : `${roundTwo(resolve.inProjectEdgeRecall)}`;
  const lines = ["## Codegraph resolve", `resolve rate: ${rate}`];
  // Plain counterpart of the DEBUG ⚠ line (bd tea-rags-mcp-znxg8). The reader
  // needs the consequence — get_callers misses callers of those services — and
  // the workaround, not the receiver-kind mechanics behind the count.
  if (languages.length > 0) {
    for (const l of languages) {
      const unnarrowed = l.callsUnnarrowedTemplate ?? 0;
      if (unnarrowed > 0) lines.push(formatUnnarrowedWarning(`${l.language}: `, unnarrowed));
    }
  } else {
    const unnarrowed = resolve.callsUnnarrowedTemplate ?? 0;
    if (unnarrowed > 0) lines.push(formatUnnarrowedWarning("", unnarrowed));
  }
  return lines;
}

function formatUnnarrowedWarning(languagePrefix: string, unnarrowed: number): string {
  return (
    `⚠ ${languagePrefix}${unnarrowed} calls like \`Service.call(...)\` are linked to a shared base method, ` +
    "not the service itself — get_callers on those services misses callers. " +
    "Find usages with hybrid_search; persists after reindex → /tea-rags:report-issue"
  );
}

/**
 * DEBUG form. tea-rags-mcp-7m5xz — render the codegraph resolve tally with its
 * per-receiver-kind breakdown so cai0 phases can read the largest unresolved
 * bucket straight from the digest. Mirrors the DTO placement: a top-level
 * `byReceiverKind` (single-language case) renders flat; nested `byLanguage` rows
 * render each kind indented under its language. Renders nothing when neither
 * breakdown is present.
 */
function formatResolveBreakdown(resolve: CodegraphResolve): string[] {
  const hasTopKinds = (resolve.byReceiverKind?.length ?? 0) > 0;
  const langsWithKinds = (resolve.byLanguage ?? []).filter((l) => (l.byReceiverKind?.length ?? 0) > 0);
  const unnarrowed = resolve.callsUnnarrowedTemplate ?? 0;
  if (!hasTopKinds && langsWithKinds.length === 0 && unnarrowed === 0) return [];

  const lines = ["## Codegraph resolve"];
  if (hasTopKinds) {
    for (const k of resolve.byReceiverKind ?? []) lines.push(formatResolveKind(k));
  } else {
    for (const l of langsWithKinds) {
      lines.push(`${l.language}:`);
      for (const k of l.byReceiverKind ?? []) lines.push(`  ${formatResolveKind(k)}`);
    }
  }
  // bd tea-rags-mcp-znxg8 — the unnarrowed-entry invariant. Rendered ONLY when
  // non-zero: zero is the healthy state and a permanent `0` line would be noise
  // in a digest read on every session. Non-zero is worth a line, because none of
  // the rates above can express it — those calls RESOLVED, they just resolved
  // onto the shared template rather than the concrete hook, so recall reads 1.0
  // while the callers of every concrete service go missing.
  //
  // This technical wording is DEBUG-only. The default digest is read by agents
  // and users who cannot act on "constant-receiver" or "self-dispatch template";
  // they get formatResolvePlain's per-language warning instead, which names the
  // consequence (get_callers misses callers) and the workaround.
  if (unnarrowed > 0) {
    lines.push(
      `⚠ ${unnarrowed} constant-receiver entry call(s) resolved to a shared self-dispatch template instead of the concrete hook — recall rates cannot see this`,
    );
  }
  return lines;
}

/**
 * Compact one-line per kind: `selfMember 0.96 125/130` (kind · rate ·
 * resolved/attempted), with ` · N unnarrowed` appended when this bucket carries
 * unnarrowed entry calls (bd tea-rags-mcp-4vg1i).
 *
 * Suffixed rather than columnar, and only when non-zero, for the same reason the
 * aggregate warning below is conditional: on a healthy index every kind reads 0
 * and a permanent zero column would be noise in a digest read every session.
 * The split is what makes the aggregate actionable — the entry strategy can only
 * narrow a CONSTANT receiver, so the same total means different things depending
 * on which bucket holds it.
 */
function formatResolveKind(k: CodegraphResolveKindRow): string {
  const base = `${k.receiverKind} ${roundTwo(k.resolveSuccessRate)} ${k.resolved}/${k.attempted}`;
  const unnarrowed = k.callsUnnarrowedTemplate ?? 0;
  return unnarrowed > 0 ? `${base} · ${unnarrowed} unnarrowed` : base;
}

function formatRelativeTime(diffMs: number): string {
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return `${days}d`;
}
