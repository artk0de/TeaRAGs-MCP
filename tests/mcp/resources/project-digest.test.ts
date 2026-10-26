import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectInProcessClient, type InProcessToolSession } from "../../../src/bootstrap/transport/in-memory.js";
import { TeaRagsError, type App } from "../../../src/core/api/public/index.js";
import { registerAllResources } from "../../../src/mcp/resources/index.js";
import { formatSlimDigest } from "../../../src/mcp/resources/project/digest.js";
import { FIXTURE_ENTRY, fixtureApp, fixtureData, NOW } from "./project/fixture.js";

describe("formatSlimDigest", () => {
  it("stays within the digest budget on a 4-language index with full thresholds buckets", () => {
    const out = formatSlimDigest(fixtureData(), NOW);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2500);
    expect(out).toContain("## Drift");
    expect(out).not.toContain("Signal thresholds");
  });

  it("opens with the alias and closes with the metrics pointer", () => {
    const lines = formatSlimDigest(fixtureData(), NOW).trimEnd().split("\n");

    expect(lines[0]).toBe("# tea-rags digest — fixture");
    expect(lines.at(-1)).toBe("→ thresholds / labelMap: tea-rags://project/fixture/metrics?language=<lang>");
  });

  it("raises the stale banner when the index is 3 days old", () => {
    expect(formatSlimDigest(fixtureData(), NOW)).toContain("⚠ Index is stale (last updated 3d ago)");
  });

  it("adds the auto-update cure line to the stale banner when auto-update is off", () => {
    expect(formatSlimDigest(fixtureData(), NOW)).toContain(
      "enable auto-update: `tea-rags auto-update enable --project fixture`",
    );
  });

  it("keeps only the codegraph resolve warnings", () => {
    const out = formatSlimDigest(fixtureData(), NOW);

    expect(out).toContain("⚠ ruby: 7 calls like `Service.call(...)`");
    expect(out).not.toContain("resolve rate:");
  });

  it("omits Infra and Enrichment while both are healthy", () => {
    const data = fixtureData();
    data.status = {
      ...data.status,
      infraHealth: {
        qdrant: { status: "green", optimizerStatus: "ok", url: "http://q", available: true },
        embedding: { provider: "ollama", available: true },
      },
      enrichment: {
        git: { file: { status: "healthy" }, chunk: { status: "healthy" } },
      },
    };

    const out = formatSlimDigest(data, NOW);

    expect(out).not.toContain("## Infra");
    expect(out).not.toContain("## Enrichment");
  });

  it("shows Infra and Enrichment when either is unhealthy", () => {
    const data = fixtureData();
    data.status = {
      ...data.status,
      infraHealth: {
        qdrant: { status: "red", optimizerStatus: "ok", url: "http://q", available: true },
        embedding: { provider: "ollama", available: true },
      },
      enrichment: {
        git: { file: { status: "healthy" }, chunk: { status: "in_progress" } },
      },
    };

    const out = formatSlimDigest(data, NOW);

    expect(out).toContain("## Infra");
    expect(out).toContain("## Enrichment");
  });

  it("stops after the status line when the project is not indexed", () => {
    const data = fixtureData();
    data.status = { isIndexed: false, status: "not_indexed" };

    const out = formatSlimDigest(data, NOW);

    expect(out).toContain("not indexed");
    expect(out).not.toContain("## Drift");
  });
});

describe("tea-rags://project/{alias}/digest template", () => {
  let session: InProcessToolSession | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await session?.close();
    session = undefined;
  });

  async function textOf(uri: string, app: App = fixtureApp()): Promise<string> {
    const server = new McpServer({ name: "tea-rags-test", version: "0.0.0" });
    registerAllResources(server, app);
    session = await connectInProcessClient(server);
    const { contents } = await session.readResource(uri);
    const [first] = contents;
    return "text" in first ? first.text : "";
  }

  it("serves the slim digest of a registered project", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    expect(await textOf("tea-rags://project/fixture/digest")).toBe(formatSlimDigest(fixtureData(), NOW));
  });

  it("answers an unknown alias with a text instead of an error", async () => {
    expect(await textOf("tea-rags://project/unknown/digest")).toBe("project 'unknown' not registered\n");
  });

  it("answers an unreadable index status with a text instead of an error", async () => {
    const app = { ...fixtureApp(), getIndexStatus: async () => Promise.reject(new Error("qdrant down")) } as App;

    expect(await textOf("tea-rags://project/fixture/digest", app)).toBe(
      "project 'fixture': index status unavailable — qdrant down\n",
    );
  });

  it("renders a typed error's message, code and hint instead of 'warm-up pending'", async () => {
    class LockedCollectionError extends TeaRagsError {
      constructor() {
        super({
          code: "INFRA_ALIAS_OPERATION",
          message: "alias swap in flight",
          hint: "Retry shortly",
          httpStatus: 409,
        });
      }
    }
    const app = {
      ...fixtureApp(),
      getIndexStatus: async () => Promise.reject(new LockedCollectionError()),
    } as App;

    const out = await textOf("tea-rags://project/fixture/digest", app);

    expect(out).not.toContain("warm-up pending");
    expect(out).toContain("alias swap in flight (INFRA_ALIAS_OPERATION)");
    expect(out).toContain("Retry shortly");
  });

  it("addresses a registry entry without a name by its collection name", async () => {
    const { name: _name, ...nameless } = FIXTURE_ENTRY;
    const app = { ...fixtureApp(), listProjects: async () => Promise.resolve({ projects: [nameless] }) } as App;

    const out = await textOf("tea-rags://project/code_fixture/digest", app);

    expect(out).toContain("# tea-rags digest — code_fixture");
    expect(out).toContain("tea-rags://project/code_fixture/metrics?language=<lang>");
  });

  it("is not enumerated by resources/list", async () => {
    await textOf("tea-rags://project/fixture/digest");
    const resources = await (session as InProcessToolSession).listResources();
    const templates = await (session as InProcessToolSession).listResourceTemplates();

    expect(resources.some((resource) => resource.uri.startsWith("tea-rags://project/"))).toBe(false);
    expect(templates.map((template) => template.uriTemplate)).toEqual(
      expect.arrayContaining([
        "tea-rags://project/{alias}/digest",
        "tea-rags://project/{alias}/metrics{?language,section}",
      ]),
    );
  });
});
