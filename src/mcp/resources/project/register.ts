import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UriTemplate, type Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";

import { TeaRagsError, type App } from "../../../core/api/public/index.js";
import { formatAgentDigest, formatFullDigest } from "./digest.js";
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
    // No digest section renders the working-tree marker, and measuring it diffs
    // the whole tree (~1 s on a 32k-file checkout) on every prime (bd o4p5l).
    app.getIndexMetrics(path, { workingTreeMarker: false }),
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
    new ResourceTemplate(new OptionalQueryUriTemplate(DIGEST_TEMPLATE), { list: undefined }),
    {
      title: "Project Digest",
      description:
        "Agent digest of a registered project: alias + collection, `codegraph off` only when off, actionable " +
        "freshness. ?view=full = human digest (drift, languages, infra)",
      mimeType: "text/markdown",
    },
    async (uri, { alias, view }) => {
      const format = listOf(view)[0] === "full" ? formatFullDigest : formatAgentDigest;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: await renderProject(app, alias, (data) => format(data, new Date())),
          },
        ],
      };
    },
  );

  server.registerResource(
    "project-metrics",
    new ResourceTemplate(new OptionalQueryUriTemplate(METRICS_TEMPLATE), { list: undefined }),
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

const DIGEST_TEMPLATE = "tea-rags://project/{alias}/digest{?view}";
const METRICS_TEMPLATE = "tea-rags://project/{alias}/metrics{?language,section}";

/**
 * The SDK's `{?a,b}` expansion matches only when every listed variable is
 * present. This keeps the template advertised as-is but reads the query as
 * optional, order-free parameters; repeated keys arrive as a list.
 */
class OptionalQueryUriTemplate extends UriTemplate {
  private readonly advertised: string;
  private readonly queryNames: string[];

  constructor(template: string) {
    super(template.replace(/\{\?[^}]*\}$/, ""));
    this.advertised = template;
    this.queryNames = /\{\?([^}]*)\}$/.exec(template)?.[1].split(",") ?? [];
  }

  override toString(): string {
    return this.advertised;
  }

  override match(uri: string): Variables | null {
    const queryStart = uri.indexOf("?");
    const path = queryStart === -1 ? uri : uri.slice(0, queryStart);
    const base = super.match(path);
    if (base === null) return null;
    if (queryStart === -1) return base;

    const variables: Variables = { ...base };
    const params = new URLSearchParams(uri.slice(queryStart + 1));
    for (const name of this.queryNames) {
      const values = params.getAll(name);
      if (values.length === 1) variables[name] = values[0];
      else if (values.length > 1) variables[name] = values;
    }
    return variables;
  }
}
