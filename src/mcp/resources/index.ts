/**
 * Resource registration module
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { App } from "../../core/api/index.js";

/**
 * Register all MCP resources on the server
 */
function buildSchemaDocumentation(app: App): string {
  const descriptors = app.getSchemaDescriptors();
  let md = "# tea-rags Schema Documentation\n\n";

  // Rerank presets section
  md += "## Rerank Presets\n\n";
  for (const [tool, names] of Object.entries(descriptors.presetNames)) {
    md += `### ${tool}\n\n`;
    for (const name of names) {
      md += `- **${name}**\n`;
    }
    md += "\n";
  }

  // Custom weight signals section
  md += "## Custom Weight Signals\n\n";
  md += "All signals accept a number (weight). Available for `{custom: {...}}` rerank mode.\n\n";
  for (const sig of descriptors.signalDescriptors) {
    md += `- **${sig.name}**: ${sig.description}\n`;
  }

  // Qdrant filter syntax section
  md += "\n## Qdrant Filter Syntax\n\n";
  md += "### Operators\n\n";
  md += '- `match: {value: "exact"}` — exact string/number match\n';
  md += '- `match: {text: "partial"}` — partial text match\n';
  md += '- `match: {any: ["a", "b"]}` — match any value in array\n';
  md += "- `range: {gte: 5, lte: 10}` — numeric range\n\n";
  md += "### Combining conditions\n\n";
  md += "- `must: [...]` — AND (all conditions must match)\n";
  md += "- `should: [...]` — OR (at least one must match)\n";
  md += "- `must_not: [...]` — NOT (none must match)\n\n";
  md += "### Available fields\n\n";
  md += "**Chunk metadata:** relativePath, fileExtension, language, startLine, endLine, ";
  md += "chunkIndex, isDocumentation, name, chunkType, parentName, parentType\n\n";
  md += "**Git metadata** (requires CODE_ENABLE_GIT_METADATA=true):\n";
  md += "git.dominantAuthor, git.authors[], git.lastModifiedAt, git.firstCreatedAt, ";
  md += "git.commitCount, git.ageDays, git.taskIds[]\n\n";
  md += "**Imports:** imports[] — file-level imports\n\n";

  // Threshold guidance
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

  // Static resource: schema documentation
  server.registerResource(
    "schema-docs",
    "tea-rags://schema/documentation",
    {
      title: "Schema Documentation",
      description:
        "Detailed documentation for tea-rags MCP tool parameters: " +
        "rerank presets, custom weight signals, filter syntax, and usage guidance.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const docs = buildSchemaDocumentation(app);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: docs }],
      };
    },
  );
}
