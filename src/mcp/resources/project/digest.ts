import type {
  CollectionEntry,
  CollectionMemoryMetrics,
  IndexStatus,
  OptimizerRecoveryTarget,
} from "../../../core/api/public/index.js";
import {
  formatIndexHolesLine,
  formatRustcDriverLine,
  isOptimizerFailure,
  renderOptimizerRecoveryCommand,
} from "../../../core/api/public/project-format.js";
import { formatLanguageCapabilitySection, formatResolveWarnings, languageSplit, registryEnv } from "./languages.js";
import type { ProjectDigestData } from "./types.js";

type InfraHealth = NonNullable<IndexStatus["infraHealth"]>;
type EnrichmentMap = NonNullable<IndexStatus["enrichment"]>;

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The agent-facing digest (`tea-rags://project/<alias>/digest`, SessionStart
 * hooks via `tea-rags prime --agent`; bd tea-rags-mcp-nknkg.1): addressing,
 * and a freshness line only when it names an action. No codegraph line: graph
 * tools absent from the tool list are the off signal. Drift, holes, infra and the rustc driver surface at their
 * trigger instead — `get_index_status` / `index_codebase` answers, degraded
 * search answers, empty graph answers.
 */
export function formatAgentDigest(
  data: Omit<ProjectDigestData, "status"> & { status: ProjectDigestData["status"] | null },
  now: Date,
): string {
  const alias = data.projectName ?? data.registry?.collectionName ?? data.path;
  const lines: string[] = [`# tea-rags digest — ${alias}`];
  if (data.status !== null && data.status.status !== "indexed") {
    lines.push(formatStatusLine(data.status, now, null));
    return `${lines.join("\n")}\n`;
  }
  const collection = `collection \`${data.status?.collectionName ?? data.registry?.collectionName ?? "unknown"}\``;
  lines.push(
    data.projectName
      ? `project \`${data.projectName}\` · ${collection} — pass \`project: "${data.projectName}"\` + \`path\` on tea-rags calls`
      : collection,
  );
  if (data.status === null) {
    lines.push("index readiness and freshness unconfirmed; use get_index_status if needed");
  } else {
    lines.push(...formatAgentFreshnessLines({ ...data, status: data.status }, alias, now));
  }
  return `${lines.join("\n")}\n`;
}

/** Freshness lines that carry an action; a fresh, drift-free index prints none. */
function formatAgentFreshnessLines(data: ProjectDigestData, alias: string, now: Date): string[] {
  const lines: string[] = [];
  const staleness = computeStaleness(data.status.lastUpdated, now);
  if (staleness?.stale) {
    lines.push(`index behind (last indexed ${staleness.ago} ago) → index_codebase(project="${alias}")`);
  }
  const holes = (data.status.indexHoles?.count ?? 0) > 0;
  if (data.drift !== null || holes) {
    lines.push(`index drift → get_index_status(project="${alias}") names the remedy`);
  }
  return lines;
}

/**
 * The full human digest (`tea-rags prime` in a terminal, `?view=full`): every
 * block — status, drift, capability, infra, enrichment. Thresholds, label maps
 * and the resolve breakdown live in the metrics resource the closing line names.
 */
export function formatFullDigest(data: ProjectDigestData, now: Date): string {
  const alias = data.projectName ?? data.registry?.collectionName ?? data.path;
  const lines: string[] = [`# tea-rags digest — ${alias}`, formatStatusLine(data.status, now, data.memory ?? null)];
  if (data.projectName) {
    lines.push(`name: \`${data.projectName}\` — pass \`project: "${data.projectName}"\` + \`path\` on tea-rags calls`);
  }
  if (data.status.status !== "indexed") {
    return `${lines.join("\n")}\n`;
  }

  const staleness = computeStaleness(data.status.lastUpdated, now);
  if (staleness?.stale) {
    lines.push(
      `⚠ Index is stale (last updated ${staleness.ago} ago). ` +
        "Run `index_codebase` before the next tea-rags search/explore.",
    );
    if (data.projectName && data.registry?.autoUpdate?.enabled !== true) {
      lines.push(`enable auto-update: \`tea-rags auto-update enable --project ${data.projectName}\``);
    }
  }

  lines.push("", "## Drift", data.drift ?? "none");
  // Snapshot files without points — drift between the snapshot and Qdrant (bd tea-rags-mcp-muj77).
  if (data.status.indexHoles && data.status.indexHoles.count > 0) {
    lines.push(formatIndexHolesLine(data.status.indexHoles.count));
  }

  const { languages, primaries } = languageSplit(data.metrics);
  if (languages.length > 1) {
    const rest = languages.filter((language) => !primaries.includes(language));
    lines.push("", `polyglot: primary ${primaries.join(", ")}${rest.length > 0 ? ` · also ${rest.join(", ")}` : ""}`);
  }

  const capabilityLines = formatLanguageCapabilitySection(
    languages,
    primaries,
    data.languageCapabilities,
    data.status.codegraphResolve,
  );
  if (capabilityLines.length > 0) lines.push("", ...capabilityLines);

  const resolveWarnings = data.status.codegraphResolve ? formatResolveWarnings(data.status.codegraphResolve) : [];
  if (resolveWarnings.length > 0) lines.push("", ...resolveWarnings);
  if (data.status.rustcDriver) lines.push("", formatRustcDriverLine(data.status.rustcDriver));

  const { infraHealth, enrichment } = data.status;
  if (infraHealth && !isInfraHealthy(infraHealth)) {
    const recoveryTarget: OptimizerRecoveryTarget = data.projectName
      ? { project: data.projectName }
      : { path: data.path };
    lines.push("", ...formatInfraSection(infraHealth, recoveryTarget));
  }
  if (enrichment && !isEnrichmentHealthy(enrichment)) {
    lines.push("", ...formatEnrichmentSection(enrichment, data.registry ?? null));
  }

  lines.push("", `→ thresholds / labelMap: tea-rags://project/${alias}/metrics?language=<lang>`);
  return `${lines.join("\n")}\n`;
}

function isInfraHealthy(infra: InfraHealth): boolean {
  const { qdrant, embedding } = infra;
  return (
    qdrant.status === "green" &&
    !isOptimizerFailure(qdrant.optimizerStatus) &&
    (embedding.primaryAvailable ?? embedding.available) &&
    embedding.fallbackAvailable !== false
  );
}

function isEnrichmentHealthy(enrichment: EnrichmentMap): boolean {
  return Object.values(enrichment).every(
    (health) => health.file.status === "healthy" && health.chunk.status === "healthy",
  );
}

// Local to the project digest: the MCP tool layer (register-status-tools) owns
// its own formatBytes; sharing one would export a presentation util through
// core/api/public.
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
 * The digest's ONE disk figure (bd tea-rags-mcp-h4iy): allocated blocks when
 * tea-rags sees the embedded storage dir, else the server's file sizes labelled
 * `apparent size` (they count Qdrant's sparsely preallocated mmap space).
 */
function formatSizeFigure(indexSizeBytes: number | undefined, memory: CollectionMemoryMetrics | null): string {
  if (indexSizeBytes !== undefined) return ` · ${formatBytes(indexSizeBytes)} on disk`;
  if (memory) return ` · ${formatBytes(memory.total.apparentDiskBytes)} apparent size`;
  return "";
}

function computeStaleness(lastUpdated: Date | undefined, now: Date): { ago: string; stale: boolean } | null {
  if (!lastUpdated) return null;
  const diffMs = now.getTime() - new Date(lastUpdated).getTime();
  return { ago: formatRelativeTime(diffMs), stale: diffMs > STALE_THRESHOLD_MS };
}

const SHORT_REASON_MAX = 40;
const ERROR_CODE_TOKEN = /\b(E[A-Z0-9]{3,}|HTTP \d{3})\b/;
/** The note a status probe appends when it read a live down verdict instead of probing (bd sm1ow). */
const CACHED_VERDICT_NOTE = / \(cached verdict, age \d+ s\)$/;

/**
 * Error-code token when the message carries one, else its first clause capped
 * at {@link SHORT_REASON_MAX} — a cached-verdict note kept after either.
 */
function shortFailureReason(message: string): string {
  const note = CACHED_VERDICT_NOTE.exec(message)?.[0] ?? "";
  return shortProbeFailure(message.slice(0, message.length - note.length)) + note;
}

function shortProbeFailure(message: string): string {
  const code = ERROR_CODE_TOKEN.exec(message);
  if (code) return code[1];
  const clause = message
    .replace(/^\S+\s+/, "")
    .split(/[:;,]/)[0]
    .trim();
  return (clause || message).slice(0, SHORT_REASON_MAX);
}

/**
 * Multi-URL tier: `url: <probe message>` entries joined by `; ` collapse to
 * `unavailable N/M: <urls — reason groups>`. Single-URL tiers and reasons that
 * do not parse as per-URL entries return undefined (legacy render).
 */
function summarizeTierFailures(tierUrl: string, reason: string | undefined): string | undefined {
  const total = tierUrl.split(",").length;
  if (total < 2 || reason === undefined) return undefined;
  const groups = new Map<string, string[]>();
  let failed = 0;
  for (const entry of reason.split(/; (?=https?:\/\/)/)) {
    const m = /^(\S+): (.+)$/s.exec(entry);
    if (!m) return undefined;
    const short = shortFailureReason(m[2]);
    groups.set(short, [...(groups.get(short) ?? []), m[1]]);
    failed += 1;
  }
  if (groups.size === 1 && failed === total) return `unavailable ${failed}/${total}: ${[...groups.keys()][0]}`;
  const parts = [...groups].map(([short, members]) => `${members.join(", ")} — ${short}`);
  return `unavailable ${failed}/${total}: ${parts.join("; ")}`;
}

/**
 * `recoveryTarget` addresses the recover command printed for a failed
 * optimizer (bd tea-rags-mcp-ye5o) — the digest only REPORTS it, never recovers.
 */
function formatInfraSection(infra: InfraHealth, recoveryTarget: OptimizerRecoveryTarget): string[] {
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
  if (isOptimizerFailure(q.optimizerStatus)) {
    lines.push(renderOptimizerRecoveryCommand(recoveryTarget));
  }

  const e = infra.embedding;
  const badge = (ok: boolean, reason?: string) =>
    ok ? "available" : reason ? `unavailable: ${reason}` : "unavailable";
  const tierBadge = (url: string, ok: boolean, reason?: string) =>
    ok ? "available" : (summarizeTierFailures(url, reason) ?? badge(ok, reason));
  if (e.url) {
    // Per-endpoint health: each ollama endpoint carries its OWN status badge.
    const primary = ` · primary ${e.url} (${tierBadge(e.url, e.primaryAvailable ?? e.available, e.primaryUnavailableReason)})`;
    const fallback = e.fallbackUrl
      ? ` · fallback ${e.fallbackUrl} (${e.fallbackAvailable === undefined ? "unknown" : tierBadge(e.fallbackUrl, e.fallbackAvailable, e.fallbackUnavailableReason)})`
      : "";
    lines.push(`embedding: ${e.provider}${primary}${fallback}`);

    // Both endpoints down may be a stale snapshot — confirm live before
    // concluding search is dead.
    const bothEndpointsDown = (e.primaryAvailable ?? e.available) === false && e.fallbackAvailable === false;
    if (bothEndpointsDown) {
      lines.push(
        "[hint] both embedding endpoints report unavailable — this digest is a snapshot at read time; " +
          "call `get_index_status` for live infra health before assuming search is down.",
      );
    }
  } else {
    // Providers without a url (e.g. onnx): keep the legacy headline form.
    lines.push(`embedding: ${badge(e.available)} · ${e.provider}`);
  }
  return lines;
}

function formatEnrichmentSection(enrichment: EnrichmentMap, registry: CollectionEntry | null): string[] {
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
 * The two git walks read DIFFERENT, sliding horizons — read from the registry
 * snapshot (what the INDEXED data was built with), never `process.env`. A key
 * the snapshot omits renders nothing.
 */
function formatGitWalkWindows(registry: CollectionEntry | null): string {
  if (!registry) return "";
  const env = registryEnv(registry);
  const declared = GIT_WALK_WINDOW_KEYS.filter(([, envKey]) => env[envKey] !== undefined).map(
    ([level, envKey]) => `${level} ${env[envKey]}mo`,
  );
  return declared.length > 0 ? ` · window ${declared.join(" / ")}` : "";
}

function formatRelativeTime(diffMs: number): string {
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return `${days}d`;
}
