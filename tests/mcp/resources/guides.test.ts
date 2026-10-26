import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { connectInProcessClient, type InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import type { PresetDescriptors } from "../../../src/core/api/public/dto/explore.js";
import type { App } from "../../../src/core/api/public/index.js";
import { nativeLanguageCapabilities, renderLanguageCapabilityGuide } from "../../../src/core/domains/language/index.js";
import { AGENT_CONTEXT_CORE, AGENT_CONTEXT_GUIDES } from "../../../src/mcp/resources/generated/agent-context.js";
import { registerAllResources, renderGuideTemplate } from "../../../src/mcp/resources/index.js";

const descriptors: PresetDescriptors = {
  presetNames: { semantic_search: ["relevance"] },
  presetDetails: {
    semantic_search: [
      { name: "relevance", description: "Pure similarity", weights: ["similarity"], tools: ["semantic_search"] },
    ],
  },
  signalDescriptors: [{ name: "similarity", description: "Semantic similarity score" }],
  payloadSignals: [
    {
      key: "git.file.commitCount",
      type: "number",
      description: "Total commits touching this file",
      treeDependence: "history-only",
      stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } },
    },
  ],
};

const TEMPLATE_TOPICS = ["overview", "presets", "signals", "filters", "search-examples", "indexing", "signal-labels"];

const collections = Array.from({ length: 46 }, (_, i) => `code_${i}`);

function stubApp(): App {
  return {
    getSchemaDescriptors: () => descriptors,
    listCollections: async () => Promise.resolve(collections),
    getCollectionInfo: async (name: string) => Promise.resolve({ name, vectorSize: 768 }),
    renderLanguageCapabilityGuide: () => renderLanguageCapabilityGuide(nativeLanguageCapabilities()),
  } as unknown as App;
}

async function textOf(session: InProcessToolSession, uri: string): Promise<string> {
  const { contents } = await session.readResource(uri);
  const [first] = contents;
  return "text" in first ? first.text : "";
}

describe("tea-rags://guide/* resources", () => {
  let session: InProcessToolSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  async function connect(): Promise<InProcessToolSession> {
    const server = new McpServer({ name: "tea-rags-test", version: "0.0.0" });
    registerAllResources(server, stubApp());
    session = await connectInProcessClient(server);
    return session;
  }

  // INVARIANT CHANGE (bd tea-rags-mcp-0y5oj): 20 → 21. The owner-approved
  // guide/architecture + guide/review add two listed rows (the answer-reading
  // prose that left two tool descriptions); the per-collection flood this cap
  // guards against stays excluded below.
  it("lists at most 21 resources and templates together, no per-collection entry", async () => {
    const s = await connect();
    const resources = await s.listResources();
    const templates = await s.listResourceTemplates();
    expect(resources.length + templates.length).toBeLessThanOrEqual(21);
    expect(resources.filter((r) => r.uri.startsWith("qdrant://collection/"))).toEqual([]);
  });

  it("serves the agent guides moved out of the injected rules", async () => {
    const s = await connect();
    for (const topic of ["navigation", "decision-tree", "freshness", "degraded"]) {
      expect(await textOf(s, `tea-rags://guide/${topic}`)).toMatch(/^# /);
    }
  });

  // bd tea-rags-mcp-0y5oj: the answer-reading prose of get_architecture_report
  // and review_changes moved out of their tool descriptions into these guides.
  it.each([
    ["architecture", ["Otsu", "maintenanceCost", "critical = active AND", "explainedPairs", "NEW_PATTERN"]],
    ["review", ["coveredPartners", "maybeAlreadyCommitted", "touchedActive", "nonLocal", "notIndexed"]],
  ])("serves the %s answer-reading guide with its moved facts", async (topic, anchors) => {
    const text = await textOf(await connect(), `tea-rags://guide/${topic}`);
    expect(text).toMatch(/^# /);
    for (const anchor of anchors) expect(text, anchor).toContain(anchor);
  });

  it("registers every builder-backed guide", async () => {
    const uris = (await (await connect()).listResources()).map((r) => r.uri);
    for (const topic of [
      "overview",
      "presets",
      "signals",
      "filters",
      "search-examples",
      "indexing",
      "signal-labels",
      "language-capability",
    ]) {
      expect(uris).toContain(`tea-rags://guide/${topic}`);
    }
  });

  it("keeps each schema/* URI as a deprecated alias serving the guide's text", async () => {
    const s = await connect();
    const aliases: Record<string, string> = {
      overview: "overview",
      presets: "presets",
      signals: "signals",
      filters: "filters",
      "search-guide": "search-examples",
      "indexing-guide": "indexing",
      "signal-labels": "signal-labels",
    };
    for (const [schema, guide] of Object.entries(aliases)) {
      expect(await textOf(s, `tea-rags://schema/${schema}`)).toBe(await textOf(s, `tea-rags://guide/${guide}`));
    }
    const listed = await s.listResources();
    expect(listed.filter((r) => r.uri.startsWith("tea-rags://schema/"))).toEqual([]);
    const template = (await s.listResourceTemplates()).find((t) => t.uriTemplate === "tea-rags://schema/{name}");
    expect(template?.description).toMatch(/^Deprecated alias of tea-rags:\/\/guide\/\*/);
    await expect(s.readResource("tea-rags://schema/unknown")).rejects.toThrow();
  });

  it("serves the language-capability matrix without the human-only section", async () => {
    const text = await textOf(await connect(), "tea-rags://guide/language-capability");
    expect(text).toContain("## Matrix");
    expect(text).not.toContain("For humans");
  });

  it("registers guide/core only when the generated core is non-empty, and one guide per generated key", async () => {
    const uris = (await (await connect()).listResources()).map((r) => r.uri);
    expect(uris.includes("tea-rags://guide/core")).toBe(AGENT_CONTEXT_CORE.length > 0);
    for (const key of Object.keys(AGENT_CONTEXT_GUIDES)) {
      expect(uris).toContain(`tea-rags://guide/${key}`);
    }
  });

  it("registers each guide URI once", async () => {
    const uris = (await (await connect()).listResources()).map((r) => r.uri);
    expect(uris.length).toBe(new Set(uris).size);
  });

  it("takes builder-backed prose from the plugin guide templates, every data placeholder substituted", async () => {
    const s = await connect();
    for (const topic of TEMPLATE_TOPICS) {
      const template = AGENT_CONTEXT_GUIDES[topic];
      expect(template, topic).toBeDefined();
      const text = await textOf(s, `tea-rags://guide/${topic}`);
      expect(text.split("\n")[0]).toBe(template.split("\n")[0]);
      expect(text).not.toContain("<!-- data:");
    }
    for (const key of Object.keys(AGENT_CONTEXT_GUIDES)) {
      expect(await textOf(s, `tea-rags://guide/${key}`)).not.toContain("<!-- data:");
    }
  });

  it("fills the template placeholders with registry data", async () => {
    const s = await connect();
    const presets = await textOf(s, "tea-rags://guide/presets");
    expect(presets).toContain("## relevance");
    expect(presets).toContain("Pure similarity");
    expect(await textOf(s, "tea-rags://guide/signals")).toContain("- **similarity**: Semantic similarity score");
    expect(await textOf(s, "tea-rags://guide/filters")).toContain(
      "File-level (`git.file.*`): commitCount, firstCreatedAt",
    );
    expect(await textOf(s, "tea-rags://guide/signal-labels")).toContain(
      "| `git.file.commitCount` | p25: low, p50: typical, p75: high, p95: extreme |",
    );
  });

  it("fails on a template placeholder with no renderer", () => {
    expect(() => renderGuideTemplate("# T\n\n<!-- data:no-such-key -->\n", {})).toThrow(/no-such-key/);
    expect(renderGuideTemplate("# T\n\n<!-- data:k -->\n\nrest\n", { k: () => "v" })).toBe("# T\n\nv\n\nrest\n");
    expect(renderGuideTemplate("# T\n\n<!-- data:k -->\n\nrest\n", { k: () => "" })).toBe("# T\n\nrest\n");
  });

  it("still reads a collection through the qdrant://collection/{name} template", async () => {
    const text = await textOf(await connect(), "qdrant://collection/code_3");
    expect(JSON.parse(text)).toEqual({ name: "code_3", vectorSize: 768 });
  });
});
