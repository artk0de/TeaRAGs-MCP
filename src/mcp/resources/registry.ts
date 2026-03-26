/**
 * Resource registration module
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { InvalidParameterError } from "../../core/api/errors.js";
import type { App } from "../../core/api/index.js";
import type { PresetDescriptors } from "../../core/api/public/dto/explore.js";

export function buildOverview(): string {
  return `# tea-rags Schema Overview

## Available Resources
- tea-rags://schema/presets — rerank presets reference
- tea-rags://schema/signals — custom weight signals reference
- tea-rags://schema/filters — Qdrant filter syntax and examples

## Tools Quick Reference
- search_code — quick semantic lookup, human-readable output
- semantic_search — analytical, structured JSON, full metadata
- hybrid_search — semantic + BM25, best for symbol name + context
- rank_chunks — rank by signals without query
- find_similar — find code similar to examples
- find_symbol — symbol definition by name, no embedding (LSP-like lookup)

## Guides
- tea-rags://schema/search-guide — search tool routing, use cases, examples
- tea-rags://schema/indexing-guide — indexing options, git metadata guide
- tea-rags://schema/signal-labels — human-readable label mappings for numeric signals

## IMPORTANT: Destructive Tools

**NEVER call these tools without explicit user confirmation:**
- \`clear_index\` — deletes ALL indexed data for a codebase (chunks, git metadata, snapshots)
- \`delete_collection\` — permanently deletes a Qdrant collection and all its data
- \`delete_documents\` — permanently deletes specific documents from a collection

These operations are **irreversible**. Re-indexing a large codebase can take minutes.
Other sessions may depend on the same index — clearing it breaks their search.

**If indexing fails with "Conflict":** another session is already indexing.
Wait for it to finish or restart the MCP server. Do NOT clear the index to work around it.
`;
}

export function buildPresetsDoc(descriptors: PresetDescriptors): string {
  const seen = new Set<string>();
  let md = "# Rerank Presets\n\n";

  for (const [, presets] of Object.entries(descriptors.presetDetails)) {
    if (presets.length === 0) continue;
    for (const p of presets) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      md += `## ${p.name}\n\n`;
      md += `${p.description}\n\n`;
      md += `**Signals:** ${p.weights.join(", ")}\n\n`;
      md += `**Tools:** ${p.tools.join(", ")}\n\n`;
    }
  }
  return md;
}

export function buildSignalsDoc(descriptors: PresetDescriptors): string {
  let md = "# Custom Weight Signals\n\n";
  md += "All signals accept a number (weight). Available for `{custom: {...}}` rerank mode.\n\n";
  for (const sig of descriptors.signalDescriptors) {
    md += `- **${sig.name}**: ${sig.description}\n`;
  }
  return md;
}

export function buildSearchGuide(): string {
  return `# Search Guide

## Tool Routing

| Need | Tool |
| --- | --- |
| Quick lookup for user request | \`search_code\` |
| Structured JSON for analytics/reports | \`semantic_search\` |
| Symbol name + semantic context | \`hybrid_search\` |
| Symbol definition by name (no embedding) | \`find_symbol\` |
| Top-N by signal without query | \`rank_chunks\` |
| Find code similar to examples | \`find_similar\` |
| Exact text, markers (TODO/FIXME) | ripgrep MCP |

For full decision logic (when to use which tool), consult the search-cascade rule.

## search_code Examples

- "Complex code not touched in 30+ days" → query="complex logic", minAgeDays=30
- "What did John work on last week?" → author="John", maxAgeDays=7
- "High-churn authentication code" → query="authentication", minCommitCount=5
- "Code related to ticket TD-1234" → taskId="TD-1234"

## semantic_search Examples

- Ownership analysis → rerank="ownership", metaOnly=true
- Tech debt discovery → rerank="techDebt", minAgeDays=90
- Security audit → rerank="securityAudit", pathPattern="**/auth/**"

## hybrid_search Examples

- Symbol + context → query="PaymentService validate card expiration"
- Class definition → query="def automations_disabled_reasons"
- Note: BM25 component currently degraded — see search-cascade Known Limitations

## find_symbol Examples

- Method definition → symbol="Reranker.rerank" (instant, no embedding)
- Class outline → symbol="Reranker" (returns members list)
- Existence check → symbol="myFunc", metaOnly=true (no content)
- With signals → symbol="Reranker.score", rerank="hotspots" (ranking overlay)

## rank_chunks Examples

- Decomposition candidates → rerank="refactoring"
- Hotspot detection → rerank="hotspots"
- Ownership reports → rerank="ownership", metaOnly=true
`;
}

export function buildIndexingGuide(): string {
  return `# Indexing Guide

## index_codebase Options

- \`path\` — root directory to index
- \`forceReindex\` — delete existing index and rebuild
- \`extensions\` — file extensions to include (default: auto-detect)
- \`ignorePatterns\` — additional ignore patterns beyond .gitignore

## Git Metadata

Set \`CODE_ENABLE_GIT_METADATA=true\` before indexing.

Enables filters:
- author — filter by dominantAuthor per chunk
- modifiedAfter/modifiedBefore — date range (ISO 8601 format)
- minAgeDays/maxAgeDays — code age
- minCommitCount — churn frequency
- taskId — extracted from commit messages (JIRA, GitHub issues)

Git enrichment runs in background after indexing. Check \`get_index_status\` for enrichment progress.

## Reindex Workflow

1. \`index_codebase\` — full initial index
2. \`reindex_changes\` — incremental update (changed files only)
3. \`get_index_status\` — check status and enrichment progress
4. \`clear_index\` — delete all indexed data (irreversible)
`;
}

export function buildFiltersDoc(): string {
  let md = "# Qdrant Filter Syntax\n\n";
  md += "## Operators\n\n";
  md += '- `match: {value: "exact"}` — exact string/number match\n';
  md += '- `match: {text: "partial"}` — partial text match\n';
  md += '- `match: {any: ["a", "b"]}` — match any value in array\n';
  md += "- `range: {gte: 5, lte: 10}` — numeric range\n\n";
  md += "## Combining conditions\n\n";
  md += "- `must: [...]` — AND (all conditions must match)\n";
  md += "- `should: [...]` — OR (at least one must match)\n";
  md += "- `must_not: [...]` — NOT (none must match)\n\n";
  md += "## Available fields\n\n";
  md += "**Chunk metadata:** relativePath, fileExtension, language, startLine, endLine, ";
  md += "chunkIndex, isDocumentation, name, chunkType, parentName, parentType\n\n";
  md += "**Git metadata** (requires enrichment, two levels):\n\n";
  md += "File-level (`git.file.*`): ageDays, commitCount, dominantAuthor, dominantAuthorPct, ";
  md += "contributorCount, authors[], lastModifiedAt, firstCreatedAt, taskIds[], ";
  md += "bugFixRate, relativeChurn, changeDensity, churnVolatility, recencyWeightedFreq\n\n";
  md += "Chunk-level (`git.chunk.*`): ageDays, commitCount, bugFixRate, churnRatio, ";
  md += "contributorCount, relativeChurn, changeDensity, churnVolatility, recencyWeightedFreq\n\n";
  md += '**⚠ Filter level:** Filters apply to `git.chunk.*` by default. Use `level: "file"` ';
  md += "parameter for file-level filters. For time-based filters (maxAgeDays/minAgeDays), ";
  md += "prefer `level: \"file\"` — chunk-level ageDays=0 means 'no data', not 'recent'.\n\n";
  md += "**Imports:** imports[] — file-level imports\n\n";
  md += "## Filter Thresholds\n\n";
  md += "Thresholds vary by codebase. Use `get_index_metrics` to get actual percentile-based ";
  md += "label boundaries for your indexed collection. Signals are scoped by `source` and `test`:\n";
  md += "```\n";
  md += 'signals["typescript"]["git.file.commitCount"]["source"].labelMap\n';
  md += "→ { low: 1, typical: 3, high: 8, extreme: 20 }\n";
  md += "```\n";
  md += 'means 8 commits = "high" for source code in that codebase. Test code has separate thresholds.\n\n';
  md += "See `tea-rags://schema/signal-labels` for all label mappings.\n";
  return md;
}

export function buildSignalLabelsGuide(): string {
  return `# Signal Labels

Signal labels provide human-readable interpretation of numeric signal values
relative to the current codebase distribution. Labels are computed from
percentile thresholds via \`get_index_metrics\` and attached to ranking overlay
results automatically.

## How Labels Work

Each numeric signal declares percentile-to-label mappings. When a search result
has a ranking overlay, numeric values are enriched with labels:

\`\`\`json
{ "commitCount": { "value": 12, "label": "high" } }
\`\`\`

The label is determined by which percentile bucket the value falls into.
Use \`get_index_metrics\` to see actual threshold values for your codebase.

## Scoped Thresholds

Signal stats are split into **source** (production code) and **test** scopes.
Test code often has different churn/size patterns — separate thresholds prevent
test noise from distorting production labels.

\`get_index_metrics\` returns:
\`\`\`
signals[language][signal][scope].labelMap
\`\`\`

Example: \`signals["ruby"]["git.file.commitCount"]["source"].labelMap\`
→ \`{ low: 2, typical: 5, high: 10, extreme: 25 }\`

If a language has test chunks indexed, a \`"test"\` scope appears with separate
thresholds. Reranker automatically uses the correct scope for label resolution.

## Git File Signals

| Signal | Labels (percentile → name) |
|--------|---------------------------|
| \`git.file.commitCount\` | p25: low, p50: typical, p75: high, p95: extreme |
| \`git.file.ageDays\` | p25: recent, p50: typical, p75: old, p95: legacy |
| \`git.file.bugFixRate\` | p50: healthy, p75: concerning, p95: critical |
| \`git.file.dominantAuthorPct\` | p25: shared, p50: mixed, p75: concentrated, p95: silo |
| \`git.file.contributorCount\` | p50: solo, p75: team, p95: crowd |
| \`git.file.relativeChurn\` | p75: normal, p95: high |
| \`git.file.changeDensity\` | p50: calm, p75: active, p95: intense |
| \`git.file.churnVolatility\` | p75: stable, p95: erratic |
| \`git.file.recencyWeightedFreq\` | p75: normal, p95: burst |

## Git Chunk Signals

| Signal | Labels (percentile → name) |
|--------|---------------------------|
| \`git.chunk.commitCount\` | p25: low, p50: typical, p75: high, p95: extreme |
| \`git.chunk.ageDays\` | p25: recent, p50: typical, p75: old, p95: legacy |
| \`git.chunk.bugFixRate\` | p50: healthy, p75: concerning, p95: critical |
| \`git.chunk.churnRatio\` | p75: normal, p95: concentrated |
| \`git.chunk.contributorCount\` | p50: solo, p95: crowd |
| \`git.chunk.relativeChurn\` | p75: normal, p95: high |
| \`git.chunk.changeDensity\` | p75: active, p95: intense |
| \`git.chunk.churnVolatility\` | p75: stable, p95: erratic |
| \`git.chunk.recencyWeightedFreq\` | p75: normal, p95: burst |

## Static Signals

| Signal | Labels (percentile → name) |
|--------|---------------------------|
| \`methodLines\` | p50: small, p75: large, p95: decomposition_candidate |
| \`methodDensity\` | p50: sparse, p95: dense |

## Label Resolution Algorithm

1. Thresholds are walked in ascending percentile order
2. Each label covers [its threshold, next threshold)
3. First label covers everything below its threshold
4. Last label covers everything at or above its threshold

Example: commitCount with thresholds p25=2, p50=5, p75=12, p95=30
- value 1 → "low" (below p25)
- value 8 → "typical" (between p50 and p75)
- value 35 → "extreme" (above p95)
`;
}

/**
 * Register all MCP resources on the server
 */
/* v8 ignore start */
export function registerAllResources(server: McpServer, app: App): void {
  // Static resource: list all collections
  server.registerResource(
    "collections",
    "qdrant://collections",
    {
      title: "All Collections",
      description: "List of all vector collections in Qdrant",
      mimeType: "application/json",
    },
    async (uri) => {
      const collections = await app.listCollections();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(collections, null, 2),
          },
        ],
      };
    },
  );

  // Dynamic resource: individual collection info
  server.registerResource(
    "collection-info",
    new ResourceTemplate("qdrant://collection/{name}", {
      list: async () => {
        const collections = await app.listCollections();
        return {
          resources: collections.map((name) => ({
            uri: `qdrant://collection/${name}`,
            name: `Collection: ${name}`,
            description: `Details and statistics for collection "${name}"`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Collection Details",
      description: "Detailed information about a specific collection",
      mimeType: "application/json",
    },
    async (uri, params) => {
      const { name } = params;
      if (typeof name !== "string" || !name) {
        throw new InvalidParameterError("name", "collection name must be a non-empty string");
      }
      const info = await app.getCollectionInfo(name);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );

  // Static resource: schema overview
  server.registerResource(
    "schema-overview",
    "tea-rags://schema/overview",
    {
      title: "Schema Overview",
      description: "Resource catalog and tools quick reference for tea-rags MCP",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildOverview() }],
    }),
  );

  // Static resource: rerank presets
  server.registerResource(
    "schema-presets",
    "tea-rags://schema/presets",
    {
      title: "Rerank Presets",
      description: "Detailed reference for rerank presets: descriptions, signals, available tools",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const descriptors = app.getSchemaDescriptors();
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildPresetsDoc(descriptors) }],
      };
    },
  );

  // Static resource: custom signals
  server.registerResource(
    "schema-signals",
    "tea-rags://schema/signals",
    {
      title: "Custom Signals",
      description: "All available weight signals for custom rerank mode with descriptions",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const descriptors = app.getSchemaDescriptors();
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildSignalsDoc(descriptors) }],
      };
    },
  );

  // Static resource: filter syntax
  server.registerResource(
    "schema-filters",
    "tea-rags://schema/filters",
    {
      title: "Filter Syntax",
      description: "Qdrant filter operators, combining conditions, available fields, and threshold guidance",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildFiltersDoc() }],
    }),
  );

  // Static resource: search guide
  server.registerResource(
    "schema-search-guide",
    "tea-rags://schema/search-guide",
    {
      title: "Search Guide",
      description: "Tool routing, use cases, and examples for all search tools",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildSearchGuide() }],
    }),
  );

  // Static resource: indexing guide
  server.registerResource(
    "schema-indexing-guide",
    "tea-rags://schema/indexing-guide",
    {
      title: "Indexing Guide",
      description: "Indexing options, git metadata guide, and reindex workflow",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildIndexingGuide() }],
    }),
  );

  // Static resource: signal labels
  server.registerResource(
    "schema-signal-labels",
    "tea-rags://schema/signal-labels",
    {
      title: "Signal Labels",
      description: "Human-readable label mappings for all numeric signals in ranking overlays",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildSignalLabelsGuide() }],
    }),
  );
}
/* v8 ignore stop */
