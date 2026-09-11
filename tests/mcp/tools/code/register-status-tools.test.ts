import { describe, expect, it, vi } from "vitest";

import type { App, IndexStatus } from "../../../../src/core/api/public/index.js";
import {
  formatBytes,
  formatCollectionDetails,
  formatInfraHealth,
  registerStatusTools,
} from "../../../../src/mcp/tools/code/register-status-tools.js";

type InfraHealth = NonNullable<IndexStatus["infraHealth"]>;

const qdrant: InfraHealth["qdrant"] = { available: true, url: "http://127.0.0.1:6333", status: "green" };

describe("formatInfraHealth — embedding endpoints", () => {
  it("renders both primary and fallback badges with their own health", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: {
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: true,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      },
    });
    expect(out).toContain(
      "Embedding (ollama): primary http://gpu-server:11434 (available), fallback http://127.0.0.1:11434 (available)",
    );
  });

  it("shows primary (unavailable) and fallback (available) under failover", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: {
        available: true,
        provider: "ollama",
        url: "http://gpu-server:11434",
        primaryAvailable: false,
        fallbackUrl: "http://127.0.0.1:11434",
        fallbackAvailable: true,
      },
    });
    expect(out).toContain(
      "Embedding (ollama): primary http://gpu-server:11434 (unavailable), fallback http://127.0.0.1:11434 (available)",
    );
  });

  it("renders a single primary badge when no fallback is configured", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: { available: true, provider: "ollama", url: "http://127.0.0.1:11434", primaryAvailable: true },
    });
    expect(out).toContain("Embedding (ollama): primary http://127.0.0.1:11434 (available)");
    expect(out).not.toContain("fallback");
  });

  it("keeps the bare availability form for providers without a url (onnx)", () => {
    const out = formatInfraHealth({
      qdrant,
      embedding: { available: true, provider: "onnx" },
    });
    expect(out).toContain("Embedding (onnx): available");
    expect(out).not.toContain("primary");
  });
});

describe("formatInfraHealth — Qdrant version", () => {
  const embedding: InfraHealth["embedding"] = { available: true, provider: "onnx" };

  it("renders the running server version next to the qdrant line when set", () => {
    const out = formatInfraHealth({ qdrant: { ...qdrant, version: "1.18.2" }, embedding });
    expect(out).toContain("Qdrant: available · v1.18.2 (http://127.0.0.1:6333)");
  });

  it("omits the version segment when unset", () => {
    const out = formatInfraHealth({ qdrant, embedding });
    expect(out).toContain("Qdrant: available (http://127.0.0.1:6333)");
    expect(out).not.toContain("· v");
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [512 * 1024, "512.0 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [1_288_490_188, "1.2 GB"],
  ])("formats %i bytes as %s (MB under 1 GB, GB at/above)", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("formatCollectionDetails — index size", () => {
  it("renders a human-readable index size line when indexSizeBytes is set", () => {
    expect(formatCollectionDetails({ indexSizeBytes: 1_288_490_188 })).toBe("Index size: 1.2 GB");
  });

  it("returns an empty string when indexSizeBytes is undefined", () => {
    expect(formatCollectionDetails({})).toBe("");
  });
});

describe("formatCollectionDetails — quantization", () => {
  it("renders turbo with the 8x annotation", () => {
    expect(formatCollectionDetails({ quantization: "turbo" })).toBe("Quantization: turbo (8x)");
  });

  it("renders scalar without annotation", () => {
    expect(formatCollectionDetails({ quantization: "scalar" })).toBe("Quantization: scalar");
  });

  it("renders none", () => {
    expect(formatCollectionDetails({ quantization: "none" })).toBe("Quantization: none");
  });

  it("renders both size and quantization on separate lines", () => {
    expect(formatCollectionDetails({ indexSizeBytes: 1_288_490_188, quantization: "turbo" })).toBe(
      "Index size: 1.2 GB\nQuantization: turbo (8x)",
    );
  });
});

// ---------------------------------------------------------------------------
// get_index_status — the Drift block (bd tea-rags-mcp-p0phi)
// ---------------------------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{ content: { type: "text"; text: string }[] }>;

function makeStatusHarness(checkIndexDrift: App["checkIndexDrift"]) {
  const captured = new Map<string, ToolHandler>();
  const register = vi.fn((_server: unknown, name: string, _config: unknown, handler: ToolHandler) => {
    captured.set(name, handler);
  });
  const app = {
    getIndexStatus: vi.fn().mockResolvedValue({
      isIndexed: true,
      status: "indexed",
      collectionName: "code_abc",
      chunksCount: 100,
    }),
    checkIndexDrift,
  } as unknown as App;

  const server = {} as Parameters<typeof registerStatusTools>[0];
  registerStatusTools(server, { app, register: register as never });
  return { handler: captured.get("get_index_status")!, app };
}

describe("get_index_status — drift block", () => {
  it("asks for a NON-consuming check, so a second call still shows the block", async () => {
    // Status is an inspection, not a search. Consuming here would make the
    // second get_index_status read "clean" and steal the warning from the next
    // search in the same process.
    const checkIndexDrift = vi.fn().mockResolvedValue("Payload keys:\n  navigation: absent → declared");
    const { handler } = makeStatusHarness(checkIndexDrift as unknown as App["checkIndexDrift"]);

    const first = await handler({ path: "/repo" }, {});
    const second = await handler({ path: "/repo" }, {});

    expect(checkIndexDrift).toHaveBeenNthCalledWith(1, { path: "/repo", consume: false });
    expect(checkIndexDrift).toHaveBeenNthCalledWith(2, { path: "/repo", consume: false });
    expect(first.content[0].text).toContain("## Drift\nPayload keys:");
    expect(second.content[0].text).toContain("## Drift\nPayload keys:");
  });

  it("appends nothing when nothing moved", async () => {
    const { handler } = makeStatusHarness(vi.fn().mockResolvedValue(null) as unknown as App["checkIndexDrift"]);

    const result = await handler({ path: "/repo" }, {});

    expect(result.content[0].text).not.toContain("## Drift");
  });
});
