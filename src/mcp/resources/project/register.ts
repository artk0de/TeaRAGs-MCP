import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TeaRagsError, type App } from "../../../core/api/public/index.js";
import { formatSlimDigest } from "./digest.js";
import { formatProjectMetrics } from "./metrics.js";
import type { ProjectDigestData, ProjectMetricsQuery } from "./types.js";

type TemplateVariable = string | string[] | undefined;

/**
 * Read one project's index state. `alias` is the registered name, or the
 * collection name of an entry registered without one. `null` = no such entry. A failed status read surfaces as
 * the `Error` it rejected with; every other read degrades to `null`.
 */
export async function loadProjectDigestData(app: App, alias: string): Promise<ProjectDigestData | null> {
  const { projects } = await app.listProjects();
  const entry = projects.find((project) => project.name === alias || project.collectionName === alias);
  if (!entry) return null;
  const { path } = entry;

  const statusRequest = app.getIndexStatus(path);
  // The memory report addresses the collection the status resolved, so it
  // chains on status and still overlaps the reads below.
  const memoryRequest = statusRequest.then(async (resolved) =>
    resolved.status === "indexed" && resolved.collectionName ? app.getCollectionMemory(resolved.collectionName) : null,
  );
  const [status, metricsResult, drift, memory] = await Promise.allSettled([
    statusRequest,
    app.getIndexMetrics(path),
    // Inspection, like get_index_status — the once-per-session warning belongs to the search path.
    app.checkIndexDrift({ path, consume: false }),
    memoryRequest,
  ]);
  if (status.status !== "fulfilled") {
    throw status.reason instanceof Error ? status.reason : new Error(String(status.reason));
  }
  const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
  return {
    path,
    projectName: entry.name ?? null,
    registry: entry,
    status: status.value,
    metrics,
    languageCapabilities: app.resolveLanguageCapabilities(Object.keys(metrics?.distributions?.language ?? {})),
    drift: drift.status === "fulfilled" ? drift.value : null,
    memory: memory.status === "fulfilled" ? memory.value : null,
  };
}

/** A template variable as a flat list — `section=a,b` and repeated `section` both arrive here. */
function listOf(value: TemplateVariable): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.flatMap((item) => item.split(",")).filter((item) => item !== "");
}

/**
 * Render a project resource, answering an unknown alias or an unreadable index
 * with text — a resource read is a lookup, not a call that can be retried.
 */
async function renderProject(
  app: App,
  alias: TemplateVariable,
  render: (data: ProjectDigestData) => string,
): Promise<string> {
  const name = listOf(alias)[0] ?? "";
  try {
    const data = await loadProjectDigestData(app, name);
    return data === null ? `project '${name}' not registered\n` : render(data);
  } catch (error) {
    return `project '${name}': index status unavailable — ${describeFailure(error)}\n`;
  }
}

/** A typed error keeps its code and hint — the reader needs the cure, not just the symptom. */
function describeFailure(error: unknown): string {
  if (error instanceof TeaRagsError) {
    return `${error.message} (${error.code})${error.hint ? `\n${error.hint}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `tea-rags://project/{alias}/digest` and `tea-rags://project/{alias}/metrics`.
 * Readable, not listed — one row per project would flood `resources/list`.
 */
export function registerProjectResources(server: McpServer, app: App): void {
  server.registerResource(
    "project-digest",
    new ResourceTemplate("tea-rags://project/{alias}/digest", { list: undefined }),
    {
      title: "Project Digest",
      description: "Slim per-session digest of a registered project: status, drift, languages, warnings",
      mimeType: "text/markdown",
    },
    async (uri, { alias }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await renderProject(app, alias, (data) => formatSlimDigest(data, new Date())),
        },
      ],
    }),
  );

  // The SDK matches a query template only when EVERY listed parameter is
  // present, so each accepted combination is its own template.
  for (const [name, template] of METRICS_TEMPLATES) {
    server.registerResource(
      name,
      new ResourceTemplate(template, { list: undefined }),
      {
        title: "Project Metrics",
        description:
          "Signal thresholds, label maps, capability tiers, codegraph resolve and registry params of a project. " +
          "?language=<lang> narrows to one language; ?section=thresholds,labelMap,capability,resolve,registry",
        mimeType: "text/markdown",
      },
      async (uri, { alias, language, section }) => {
        const query: ProjectMetricsQuery = { language: listOf(language)[0], section: listOf(section) };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: await renderProject(app, alias, (data) => formatProjectMetrics(data, query)),
            },
          ],
        };
      },
    );
  }
}

/** Metrics URIs: no query, `?language`, `?section`, or `?language=…&section=…` in that order. */
const METRICS_TEMPLATES: readonly (readonly [name: string, template: string])[] = [
  ["project-metrics", "tea-rags://project/{alias}/metrics{?language,section}"],
  ["project-metrics-language", "tea-rags://project/{alias}/metrics{?language}"],
  ["project-metrics-section", "tea-rags://project/{alias}/metrics{?section}"],
  ["project-metrics-all", "tea-rags://project/{alias}/metrics"],
];
