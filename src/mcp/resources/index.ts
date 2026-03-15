/**
 * Resource registration module
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
- hybrid_search — semantic + BM25, best for mixed intent
- rank_chunks — rank by signals without query
- find_similar — find code similar to examples
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
  md += "**Git metadata** (requires CODE_ENABLE_GIT_METADATA=true):\n";
  md += "git.dominantAuthor, git.authors[], git.lastModifiedAt, git.firstCreatedAt, ";
  md += "git.commitCount, git.ageDays, git.taskIds[]\n\n";
  md += "**Imports:** imports[] — file-level imports\n\n";
  md += "## Filter Thresholds\n\n";
  md += "Typical values (vary by codebase):\n\n";
  md += "- `minCommitCount: 5` — high churn threshold\n";
  md += "- `minCommitCount: 10` — very high churn\n";
  md += "- `minAgeDays: 30` — older than a month\n";
  md += "- `minAgeDays: 90` — legacy code\n";
  md += "- `maxAgeDays: 7` — last week's changes\n";
  md += "- `maxAgeDays: 30` — last month's changes\n";
  return md;
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
        throw new Error("Invalid collection name parameter");
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
}
/* v8 ignore stop */
