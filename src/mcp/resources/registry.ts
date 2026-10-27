/**
 * Resource registration module
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DEFAULT_META_ONLY_FIELDS,
  DEFAULT_SEARCH_FIELDS,
  InvalidParameterError,
  type App,
  type PayloadSignalDescriptor,
  type PresetDescriptors,
} from "../../core/api/public/index.js";
import { AGENT_CONTEXT_CORE, AGENT_CONTEXT_GUIDES } from "./generated/agent-context.js";
import { registerProjectResources } from "./project/register.js";

/**
 * The metaOnly response contract — stated once, here. Every search tool's
 * `metaOnly` hint points at it (filterMetaOnly / applyEssentialSignals select
 * raw fields; BaseExploreStrategy#applyMetaOnly keeps rankingOverlay).
 */
export const META_ONLY_CONTRACT =
  `No fields → search tools' payload = ${DEFAULT_META_ONLY_FIELDS.join(", ")} ` +
  "(signature = first code line, ≤160 chars; find_symbol adds chunkType, language); " +
  `content mode = ${DEFAULT_SEARCH_FIELDS.join(", ")}. Search rows carry id / score only when fields is passed; ` +
  "find_similar positiveIds / negativeIds take a row's symbolId. Raw git.* / codegraph.* / imports / navigation dropped, rerank or not. " +
  "Labels live only in rankingOverlay.{file,chunk}.<field> ({value,label} when labelled, else raw), " +
  "present whenever rerank ran. Payload never {value,label}. Raw signal → fields with its dot-path " +
  '(["git"] = whole subtree; paths + value forms same as without metaOnly).';

/** Renderers for the `<!-- data:<key> -->` blocks of one guide template, by key. */
export type GuideData = Readonly<Record<string, () => string>>;

const DATA_PLACEHOLDER = /^<!-- data:([a-z0-9-]+) -->\n(\n?)/gm;

/**
 * `template` with each `<!-- data:<key> -->` line replaced by `data[key]()`.
 * An empty block drops the line and the blank line after it; a key with no
 * renderer throws.
 */
export function renderGuideTemplate(template: string, data: GuideData): string {
  return template.replace(DATA_PLACEHOLDER, (_line, key: string, gap: string) => {
    if (!Object.hasOwn(data, key)) throw new Error(`guide template names unknown data block "${key}"`);
    const block = data[key]();
    return block ? `${block}\n${gap}` : "";
  });
}

/** Prose of a builder-backed guide: `plugins/tea-rags/rules/guides/<topic>.md`. */
function guideTemplate(topic: string): string {
  const template = AGENT_CONTEXT_GUIDES[topic];
  if (template === undefined) throw new Error(`no guide template plugins/tea-rags/rules/guides/${topic}.md`);
  return template;
}

export function buildOverview(): string {
  return renderGuideTemplate(guideTemplate("overview"), { "meta-only-contract": () => META_ONLY_CONTRACT });
}

function presetSections(descriptors: PresetDescriptors): string {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const [, presets] of Object.entries(descriptors.presetDetails)) {
    if (presets.length === 0) continue;
    for (const p of presets) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      sections.push(
        `## ${p.name}\n\n${p.description}\n\n**Signals:** ${p.weights.join(", ")}\n\n**Tools:** ${p.tools.join(", ")}`,
      );
    }
  }
  return sections.join("\n\n");
}

export function buildPresetsDoc(descriptors: PresetDescriptors): string {
  return renderGuideTemplate(guideTemplate("presets"), { "presets-sections": () => presetSections(descriptors) });
}

export function buildSignalsDoc(descriptors: PresetDescriptors): string {
  return renderGuideTemplate(guideTemplate("signals"), {
    "signal-keys": () => descriptors.signalDescriptors.map((sig) => `- **${sig.name}**: ${sig.description}`).join("\n"),
  });
}

export function buildSearchGuide(): string {
  return renderGuideTemplate(guideTemplate("search-examples"), {});
}

export function buildIndexingGuide(): string {
  return renderGuideTemplate(guideTemplate("indexing"), {});
}

/**
 * Git payload keys the filters resource names that the trajectory WRITES to the
 * payload but does NOT declare as payload signal descriptors — verified at the
 * writer (`domains/trajectory/git/infra/metrics/file-assembler.ts`). Since
 * bd tea-rags-mcp-9ot33 declared `git.{file,chunk}.lastModifiedAt` as payload
 * signal descriptors (their percentiles feed the now-relative age floor and
 * label bands), `git.file.firstCreatedAt` is the only remaining
 * written-but-undeclared key; it is read back by the git stats accumulators.
 * The git field enumeration in buildFiltersDoc is GENERATED from the
 * descriptors, so a key appears there either because a descriptor declares it
 * or because it is listed here explicitly. Anything else is a stale name (the
 * schema-v13 contributorCount/authors drift) and the key-existence test in
 * tests/mcp/resources/resources.test.ts fails on it.
 */
export const FILTERS_DOC_WRITTEN_BUT_UNDECLARED_KEYS = ["git.file.firstCreatedAt"] as const;

/** Render the field enumeration line for one git payload level from the descriptors. */
function gitFilterFields(payloadSignals: PayloadSignalDescriptor[], prefix: string): string {
  const field = (key: string) => {
    const name = key.slice(prefix.length);
    const isArray = payloadSignals.find((s) => s.key === key)?.type === "string[]";
    return isArray ? `${name}[]` : name;
  };
  const declared = payloadSignals.filter((s) => s.key.startsWith(prefix)).map((s) => field(s.key));
  const undeclared = FILTERS_DOC_WRITTEN_BUT_UNDECLARED_KEYS.filter((key) => key.startsWith(prefix)).map(field);
  return [...declared, ...undeclared].join(", ");
}

export function buildFiltersDoc(payloadSignals: PayloadSignalDescriptor[]): string {
  // Field lists GENERATED from the payload signal descriptors (single source of
  // truth) — a renamed descriptor key updates this doc through the registry
  // (bd tea-rags-mcp-yd6zp).
  return renderGuideTemplate(guideTemplate("filters"), {
    "git-fields": () =>
      `File-level (\`git.file.*\`): ${gitFilterFields(payloadSignals, "git.file.")}\n\n` +
      `Chunk-level (\`git.chunk.*\`): ${gitFilterFields(payloadSignals, "git.chunk.")}`,
  });
}

export function buildSignalLabelsGuide(payloadSignals: PayloadSignalDescriptor[]): string {
  return renderGuideTemplate(guideTemplate("signal-labels"), { "label-tables": () => labelTables(payloadSignals) });
}

/** One `## <group>` Markdown table per domain group of the signals that declare labels. */
function labelTables(payloadSignals: PayloadSignalDescriptor[]): string {
  // Filter to signals with stats.labels
  const withLabels = payloadSignals.filter((s) => s.stats?.labels && Object.keys(s.stats.labels).length > 0);

  // Group by domain prefix
  const groups = new Map<string, PayloadSignalDescriptor[]>();
  for (const signal of withLabels) {
    const prefix = getDomainGroup(signal.key);
    let group = groups.get(prefix);
    if (!group) {
      group = [];
      groups.set(prefix, group);
    }
    group.push(signal);
  }

  const tables: string[] = [];
  for (const [groupName, signals] of groups) {
    const signalRows = signals.map((signal) => {
      /* v8 ignore start -- stats.labels guaranteed by withLabels filter */
      const labels = signal.stats?.labels ?? {};
      /* v8 ignore stop */
      const entries = Object.entries(labels)
        .sort((a, b) => parsePercentile(a[0]) - parsePercentile(b[0]))
        .map(([p, name]) => `${p}: ${name}`)
        .join(", ");
      return `| \`${signal.key}\` | ${entries} |`;
    });
    tables.push(
      [
        `## ${groupName}`,
        "",
        "| Signal | Labels (percentile → name) |",
        "|--------|---------------------------|",
        ...signalRows,
      ].join("\n"),
    );
  }
  return tables.join("\n\n");
}

/** Map a signal key to a human-readable group name. */
function getDomainGroup(key: string): string {
  if (key.startsWith("git.file.")) return "Git File Signals";
  if (key.startsWith("git.chunk.")) return "Git Chunk Signals";
  return "Static Signals";
}

/** Parse percentile number from "pNN" key. */
function parsePercentile(key: string): number {
  return parseInt(key.replace("p", ""), 10) || 0;
}

/** One static markdown resource: identity, listing text, and its renderer. */
export interface MarkdownResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  render: () => string;
}

/** Register a static `text/markdown` resource whose body is `render()` at read time. */
export function registerMarkdown(server: McpServer, resource: MarkdownResource): void {
  const { name, uri, title, description, render } = resource;
  server.registerResource(name, uri, { title, description, mimeType: "text/markdown" }, async (requested) => ({
    contents: [{ uri: requested.href, mimeType: "text/markdown", text: render() }],
  }));
}

/** Builder-backed guide; `schemaAlias` = the legacy `tea-rags://schema/*` name still served. */
interface BuilderBackedGuide {
  topic: string;
  schemaAlias?: string;
  title: string;
  description: string;
  render: () => string;
}

function builtGuides(app: App): BuilderBackedGuide[] {
  return [
    {
      topic: "overview",
      schemaAlias: "overview",
      title: "Schema Overview",
      description: "Resource catalog, tools quick reference, full param reference for tea-rags MCP",
      render: () => buildOverview(),
    },
    {
      topic: "presets",
      schemaAlias: "presets",
      title: "Rerank Presets",
      description: "Detailed reference for rerank presets: descriptions, signals, available tools",
      render: () => buildPresetsDoc(app.getSchemaDescriptors()),
    },
    {
      topic: "signals",
      schemaAlias: "signals",
      title: "Custom Signals",
      description: "All available weight signals for custom rerank mode with descriptions",
      render: () => buildSignalsDoc(app.getSchemaDescriptors()),
    },
    {
      topic: "filters",
      schemaAlias: "filters",
      title: "Filter Syntax",
      description: "Qdrant filter operators, combining conditions, available fields, and threshold guidance",
      render: () => buildFiltersDoc(app.getSchemaDescriptors().payloadSignals),
    },
    {
      topic: "search-examples",
      schemaAlias: "search-guide",
      title: "Search Guide",
      description: "Tool routing, use cases, and examples for all search tools",
      render: () => buildSearchGuide(),
    },
    {
      topic: "indexing",
      schemaAlias: "indexing-guide",
      title: "Indexing Guide",
      description: "Indexing options, git metadata guide, and reindex workflow",
      render: () => buildIndexingGuide(),
    },
    {
      topic: "signal-labels",
      schemaAlias: "signal-labels",
      title: "Signal Labels",
      description: "Human-readable label mappings for all numeric signals in ranking overlays",
      render: () => buildSignalLabelsGuide(app.getSchemaDescriptors().payloadSignals),
    },
    {
      topic: "language-capability",
      title: "Language Capability",
      description:
        "Per-language trust ceiling: AST chunking, test chunking, codegraph tier. Scales + realized-trust note",
      render: () => app.renderLanguageCapabilityGuide(),
    },
  ];
}

/** Title for a plugin-rule guide: its first `# ` heading, else the key. */
function markdownTitle(markdown: string, fallback: string): string {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;
}

/**
 * `tea-rags://guide/*` — builder-backed guides, their deprecated
 * `tea-rags://schema/*` aliases, and the plugin-rule guides generated into
 * `AGENT_CONTEXT_GUIDES` (`guide/core` only when the core is non-empty).
 */
/**
 * `tea-rags://schema/{name}` — deprecated aliases of the builder-backed guides,
 * readable for one release, not listed: seven extra rows would break the
 * `resources/list` budget of 21.
 */
function registerSchemaAliases(server: McpServer, guides: BuilderBackedGuide[]): void {
  const byAlias = new Map(guides.flatMap((guide) => (guide.schemaAlias ? [[guide.schemaAlias, guide] as const] : [])));
  server.registerResource(
    "schema-alias",
    new ResourceTemplate("tea-rags://schema/{name}", { list: undefined }),
    {
      title: "Schema (deprecated)",
      description: `Deprecated alias of tea-rags://guide/*: ${[...byAlias]
        .map(([alias, { topic }]) => (alias === topic ? alias : `${alias} → ${topic}`))
        .join(", ")}`,
      mimeType: "text/markdown",
    },
    async (uri, { name }) => {
      const guide = typeof name === "string" ? byAlias.get(name) : undefined;
      if (!guide) throw new InvalidParameterError("name", `unknown schema alias; read tea-rags://guide/* instead`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide.render() }] };
    },
  );
}

function registerGuides(server: McpServer, app: App): void {
  const guides = builtGuides(app);
  for (const { topic, title, description, render } of guides) {
    registerMarkdown(server, { name: `guide-${topic}`, uri: `tea-rags://guide/${topic}`, title, description, render });
  }
  registerSchemaAliases(server, guides);
  if (AGENT_CONTEXT_CORE.length > 0) {
    registerMarkdown(server, {
      name: "guide-core",
      uri: "tea-rags://guide/core",
      title: markdownTitle(AGENT_CONTEXT_CORE, "core"),
      description: "Always-on agent rules: search routing, addressing, freshness",
      render: () => AGENT_CONTEXT_CORE,
    });
  }
  const builderTopics = new Set(guides.map(({ topic }) => topic));
  for (const [key, markdown] of Object.entries(AGENT_CONTEXT_GUIDES)) {
    if (builderTopics.has(key)) continue;
    registerMarkdown(server, {
      name: `guide-${key}`,
      uri: `tea-rags://guide/${key}`,
      title: markdownTitle(markdown, key),
      description: `Agent guide: ${key}. Read on demand`,
      render: () => markdown,
    });
  }
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

  // Template: individual collection info. Readable, not listed — one row per
  // collection would flood `resources/list`.
  server.registerResource(
    "collection-info",
    new ResourceTemplate("qdrant://collection/{name}", { list: undefined }),
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

  registerGuides(server, app);
  registerProjectResources(server, app);
}
/* v8 ignore stop */
