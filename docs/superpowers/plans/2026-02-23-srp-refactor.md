# SRP Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Decompose the God-file `src/index.ts` into domain modules and
eliminate code duplication in `src/tools/`.

**Architecture:** Extract 6 responsibilities from `src/index.ts` into `config/`,
`transport/`, `server/`, and `providers/` domains. Extract shared formatters
from `tools/code.ts` and `tools/search.ts` into `tools/formatters/`. Every new
module is pure functions or single-responsibility classes with explicit
dependencies — no globals.

**Tech Stack:** TypeScript, Vitest, MCP SDK, Express, Bottleneck

---

## Task 1: Create `src/config/env.ts` — Environment Parsing

**Files:**

- Create: `src/config/env.ts`
- Test: `src/config/env.test.ts`

**Step 1: Write the failing test**

```typescript
// src/config/env.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAppConfig } from "./env.js";

describe("parseAppConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return defaults when no env vars set", () => {
    // Clear relevant vars
    delete process.env.QDRANT_URL;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.TRANSPORT_MODE;
    delete process.env.HTTP_PORT;

    const config = parseAppConfig();

    expect(config.qdrantUrl).toBe("http://localhost:6333");
    expect(config.embeddingProvider).toBe("ollama");
    expect(config.transportMode).toBe("stdio");
    expect(config.httpPort).toBe(3000);
    expect(config.code.chunkSize).toBe(2500);
    expect(config.code.chunkOverlap).toBe(300);
    expect(config.code.enableASTChunking).toBe(true);
    expect(config.code.batchSize).toBe(100);
    expect(config.code.defaultSearchLimit).toBe(5);
    expect(config.code.enableHybridSearch).toBe(false);
    expect(config.code.enableGitMetadata).toBe(false);
  });

  it("should parse env vars when set", () => {
    process.env.QDRANT_URL = "http://custom:6333";
    process.env.QDRANT_API_KEY = "secret";
    process.env.EMBEDDING_PROVIDER = "OpenAI";
    process.env.TRANSPORT_MODE = "HTTP";
    process.env.HTTP_PORT = "8080";
    process.env.CODE_CHUNK_SIZE = "5000";
    process.env.CODE_ENABLE_GIT_METADATA = "true";
    process.env.CODE_ENABLE_HYBRID = "true";

    const config = parseAppConfig();

    expect(config.qdrantUrl).toBe("http://custom:6333");
    expect(config.qdrantApiKey).toBe("secret");
    expect(config.embeddingProvider).toBe("openai");
    expect(config.transportMode).toBe("http");
    expect(config.httpPort).toBe(8080);
    expect(config.code.chunkSize).toBe(5000);
    expect(config.code.enableGitMetadata).toBe(true);
    expect(config.code.enableHybridSearch).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/env.test.ts` Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/config/env.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CODE_EXTENSIONS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_SEARCH_LIMIT,
} from "../code/config.js";
import type { CodeConfig } from "../code/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  qdrantUrl: string;
  qdrantApiKey?: string;
  embeddingProvider: string;
  transportMode: "stdio" | "http";
  httpPort: number;
  requestTimeoutMs: number;
  promptsConfigFile: string;
  code: CodeConfig;
}

export function parseAppConfig(): AppConfig {
  const transportMode = (process.env.TRANSPORT_MODE || "stdio").toLowerCase();

  return {
    qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
    qdrantApiKey: process.env.QDRANT_API_KEY,
    embeddingProvider: (
      process.env.EMBEDDING_PROVIDER || "ollama"
    ).toLowerCase(),
    transportMode: transportMode as "stdio" | "http",
    httpPort: parseInt(process.env.HTTP_PORT || "3000", 10),
    requestTimeoutMs: parseInt(
      process.env.HTTP_REQUEST_TIMEOUT_MS || "300000",
      10,
    ),
    promptsConfigFile:
      process.env.PROMPTS_CONFIG_FILE || join(__dirname, "../../prompts.json"),
    code: {
      chunkSize: parseInt(
        process.env.CODE_CHUNK_SIZE || String(DEFAULT_CHUNK_SIZE),
        10,
      ),
      chunkOverlap: parseInt(
        process.env.CODE_CHUNK_OVERLAP || String(DEFAULT_CHUNK_OVERLAP),
        10,
      ),
      enableASTChunking: process.env.CODE_ENABLE_AST !== "false",
      supportedExtensions: DEFAULT_CODE_EXTENSIONS,
      ignorePatterns: DEFAULT_IGNORE_PATTERNS,
      batchSize: parseInt(
        process.env.QDRANT_UPSERT_BATCH_SIZE ||
          process.env.CODE_BATCH_SIZE ||
          String(DEFAULT_BATCH_SIZE),
        10,
      ),
      defaultSearchLimit: parseInt(
        process.env.CODE_SEARCH_LIMIT || String(DEFAULT_SEARCH_LIMIT),
        10,
      ),
      enableHybridSearch: process.env.CODE_ENABLE_HYBRID === "true",
      enableGitMetadata: process.env.CODE_ENABLE_GIT_METADATA === "true",
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/env.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "refactor: extract env parsing into config/env.ts"
```

---

## Task 2: Create `src/config/validate.ts` — Config Validation

**Files:**

- Create: `src/config/validate.ts`
- Test: `src/config/validate.test.ts`

**Step 1: Write the failing test**

```typescript
// src/config/validate.test.ts
import { describe, expect, it } from "vitest";

import type { AppConfig } from "./env.js";
import { validateConfig } from "./validate.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    qdrantUrl: "http://localhost:6333",
    embeddingProvider: "ollama",
    transportMode: "stdio",
    httpPort: 3000,
    requestTimeoutMs: 300000,
    promptsConfigFile: "/tmp/prompts.json",
    code: {
      chunkSize: 2500,
      chunkOverlap: 300,
      enableASTChunking: true,
      supportedExtensions: [".ts"],
      ignorePatterns: ["node_modules/**"],
      batchSize: 100,
      defaultSearchLimit: 5,
      enableHybridSearch: false,
      enableGitMetadata: false,
    },
    ...overrides,
  };
}

describe("validateConfig", () => {
  it("should pass for valid stdio config", () => {
    expect(() => validateConfig(makeConfig())).not.toThrow();
  });

  it("should pass for valid http config", () => {
    expect(() =>
      validateConfig(makeConfig({ transportMode: "http" })),
    ).not.toThrow();
  });

  it("should throw for invalid transport mode", () => {
    expect(() =>
      validateConfig(makeConfig({ transportMode: "grpc" as any })),
    ).toThrow(/transport/i);
  });

  it("should throw for invalid HTTP port in http mode", () => {
    expect(() =>
      validateConfig(makeConfig({ transportMode: "http", httpPort: 0 })),
    ).toThrow(/port/i);
    expect(() =>
      validateConfig(makeConfig({ transportMode: "http", httpPort: 70000 })),
    ).toThrow(/port/i);
    expect(() =>
      validateConfig(makeConfig({ transportMode: "http", httpPort: NaN })),
    ).toThrow(/port/i);
  });

  it("should not validate port for stdio mode", () => {
    expect(() =>
      validateConfig(makeConfig({ transportMode: "stdio", httpPort: 0 })),
    ).not.toThrow();
  });

  it("should throw for invalid requestTimeoutMs in http mode", () => {
    expect(() =>
      validateConfig(
        makeConfig({ transportMode: "http", requestTimeoutMs: -1 }),
      ),
    ).toThrow(/timeout/i);
    expect(() =>
      validateConfig(
        makeConfig({ transportMode: "http", requestTimeoutMs: NaN }),
      ),
    ).toThrow(/timeout/i);
  });

  it("should throw for unknown embedding provider", () => {
    expect(() =>
      validateConfig(makeConfig({ embeddingProvider: "unknown" })),
    ).toThrow(/provider/i);
  });

  it("should accept all known providers", () => {
    for (const provider of ["ollama", "openai", "cohere", "voyage"]) {
      expect(() =>
        validateConfig(makeConfig({ embeddingProvider: provider })),
      ).not.toThrow();
    }
  });

  it("should throw when non-ollama provider has no API key in env", () => {
    // Ensure no keys set
    delete process.env.OPENAI_API_KEY;
    expect(() =>
      validateConfig(makeConfig({ embeddingProvider: "openai" })),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/validate.test.ts` Expected: FAIL — module not
found

**Step 3: Write minimal implementation**

```typescript
// src/config/validate.ts
import type { AppConfig } from "./env.js";

const VALID_PROVIDERS = ["ollama", "openai", "cohere", "voyage"];
const VALID_TRANSPORT_MODES = ["stdio", "http"];

const PROVIDER_API_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  cohere: "COHERE_API_KEY",
  voyage: "VOYAGE_API_KEY",
};

export function validateConfig(config: AppConfig): void {
  // Validate transport mode
  if (!VALID_TRANSPORT_MODES.includes(config.transportMode)) {
    throw new Error(
      `Invalid transport mode "${config.transportMode}". Supported: ${VALID_TRANSPORT_MODES.join(", ")}.`,
    );
  }

  // Validate HTTP port (only when HTTP mode)
  if (config.transportMode === "http") {
    if (
      Number.isNaN(config.httpPort) ||
      config.httpPort < 1 ||
      config.httpPort > 65535
    ) {
      throw new Error(
        `Invalid HTTP port "${config.httpPort}". Must be between 1 and 65535.`,
      );
    }

    if (Number.isNaN(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
      throw new Error(
        `Invalid request timeout "${config.requestTimeoutMs}". Must be a positive number.`,
      );
    }
  }

  // Validate embedding provider
  if (!VALID_PROVIDERS.includes(config.embeddingProvider)) {
    throw new Error(
      `Unknown embedding provider "${config.embeddingProvider}". Supported: ${VALID_PROVIDERS.join(", ")}.`,
    );
  }

  // Validate API keys for non-ollama providers
  if (config.embeddingProvider !== "ollama") {
    const requiredKeyName = PROVIDER_API_KEY_MAP[config.embeddingProvider];
    if (requiredKeyName && !process.env[requiredKeyName]) {
      throw new Error(
        `${requiredKeyName} is required for ${config.embeddingProvider} provider.`,
      );
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/validate.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/config/validate.ts src/config/validate.test.ts
git commit -m "refactor: extract config validation into config/validate.ts"
```

---

## Task 3: Create `src/providers/ollama-check.ts` — Ollama Health Check

**Files:**

- Create: `src/providers/ollama-check.ts`
- Test: `src/providers/ollama-check.test.ts`

**Step 1: Write the failing test**

```typescript
// src/providers/ollama-check.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkOllamaAvailability } from "./ollama-check.js";

describe("checkOllamaAvailability", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip check for non-ollama providers", async () => {
    await checkOllamaAvailability("openai");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should succeed when ollama is running and model exists", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // version check
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [{ name: "jina-embeddings-v2-base-code:latest" }],
          }),
      }); // tags check
    vi.stubGlobal("fetch", mockFetch);

    await expect(checkOllamaAvailability("ollama")).resolves.toBeUndefined();
  });

  it("should throw when ollama is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Connection refused")),
    );

    await expect(checkOllamaAvailability("ollama")).rejects.toThrow(/ollama/i);
  });

  it("should throw when model is not found", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: "other-model" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await expect(checkOllamaAvailability("ollama")).rejects.toThrow(
      /not found/i,
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/ollama-check.test.ts` Expected: FAIL — module
not found

**Step 3: Write minimal implementation**

Move `checkOllamaAvailability()` from `src/index.ts` lines 81-139 into
`src/providers/ollama-check.ts`. Convert from closure over globals to explicit
parameter:

```typescript
// src/providers/ollama-check.ts
export async function checkOllamaAvailability(
  embeddingProvider: string,
  baseUrl?: string,
  modelName?: string,
): Promise<void> {
  if (embeddingProvider !== "ollama") return;

  const url =
    baseUrl || process.env.EMBEDDING_BASE_URL || "http://localhost:11434";
  const model =
    modelName || process.env.EMBEDDING_MODEL || "jina-embeddings-v2-base-code";
  const isLocalhost = url.includes("localhost") || url.includes("127.0.0.1");

  try {
    const response = await fetch(`${url}/api/version`);
    if (!response.ok) {
      throw new Error(`Ollama returned status ${response.status}`);
    }

    const tagsResponse = await fetch(`${url}/api/tags`);
    const { models } = (await tagsResponse.json()) as {
      models: { name: string }[];
    };
    const modelExists = models.some(
      (m) => m.name === model || m.name.startsWith(`${model}:`),
    );

    if (!modelExists) {
      let msg = `Error: Model '${model}' not found in Ollama.\n`;
      if (isLocalhost) {
        msg +=
          `Pull it with:\n` +
          `  - Using Podman: podman exec ollama ollama pull ${model}\n` +
          `  - Using Docker: docker exec ollama ollama pull ${model}\n` +
          `  - Or locally: ollama pull ${model}`;
      } else {
        msg += `Please ensure the model is available on your Ollama instance:\n  ollama pull ${model}`;
      }
      throw new Error(msg);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Error: Model")) {
      throw error;
    }

    const errorMessage =
      error instanceof Error
        ? `Error: ${error.message}`
        : `Error: Ollama is not running at ${url}.\n`;

    let helpText = "";
    if (isLocalhost) {
      helpText =
        `Please start Ollama:\n` +
        `  - Using Podman: podman compose up -d\n` +
        `  - Using Docker: docker compose up -d\n` +
        `  - Or install locally: curl -fsSL https://ollama.ai/install.sh | sh\n` +
        `\nThen pull the embedding model:\n` +
        `  ollama pull jina-embeddings-v2-base-code`;
    } else {
      helpText =
        `Please ensure:\n` +
        `  - Ollama is running at the specified URL\n` +
        `  - The URL is accessible from this machine\n` +
        `  - The embedding model is available (e.g., jina-embeddings-v2-base-code)`;
    }

    throw new Error(`${errorMessage}\n${helpText}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/ollama-check.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/ollama-check.ts src/providers/ollama-check.test.ts
git commit -m "refactor: extract Ollama health check into providers/ollama-check.ts"
```

---

## Task 4: Create `src/server/factory.ts` — DI Wiring & MCP Server

**Files:**

- Create: `src/server/factory.ts`
- Test: `src/server/factory.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/factory.test.ts
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config/env.js";
import { createAppContext, createConfiguredServer } from "./factory.js";

// Mock heavy dependencies
vi.mock("../qdrant/client.js", () => ({
  QdrantManager: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../embeddings/factory.js", () => ({
  EmbeddingProviderFactory: {
    createFromEnv: vi.fn().mockReturnValue({ getDimensions: () => 768 }),
  },
}));
vi.mock("../code/indexer.js", () => ({
  CodeIndexer: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../tools/index.js", () => ({
  registerAllTools: vi.fn(),
}));
vi.mock("../resources/index.js", () => ({
  registerAllResources: vi.fn(),
}));
vi.mock("../prompts/register.js", () => ({
  registerAllPrompts: vi.fn(),
}));

function makeConfig(): AppConfig {
  return {
    qdrantUrl: "http://localhost:6333",
    embeddingProvider: "ollama",
    transportMode: "stdio",
    httpPort: 3000,
    requestTimeoutMs: 300000,
    promptsConfigFile: "/nonexistent/prompts.json",
    code: {
      chunkSize: 2500,
      chunkOverlap: 300,
      enableASTChunking: true,
      supportedExtensions: [".ts"],
      ignorePatterns: [],
      batchSize: 100,
      defaultSearchLimit: 5,
      enableHybridSearch: false,
    },
  };
}

describe("createAppContext", () => {
  it("should create qdrant, embeddings, and codeIndexer", () => {
    const ctx = createAppContext(makeConfig());
    expect(ctx.qdrant).toBeDefined();
    expect(ctx.embeddings).toBeDefined();
    expect(ctx.codeIndexer).toBeDefined();
  });
});

describe("createConfiguredServer", () => {
  it("should return an MCP server", () => {
    const ctx = createAppContext(makeConfig());
    const server = createConfiguredServer(ctx, null);
    expect(server).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/factory.test.ts` Expected: FAIL — module not
found

**Step 3: Write minimal implementation**

```typescript
// src/server/factory.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CodeIndexer } from "../code/indexer.js";
import type { AppConfig } from "../config/env.js";
import { EmbeddingProviderFactory } from "../embeddings/factory.js";
import { loadPromptsConfig, type PromptsConfig } from "../prompts/index.js";
import { registerAllPrompts } from "../prompts/register.js";
import { QdrantManager } from "../qdrant/client.js";
import { registerAllResources } from "../resources/index.js";
import { registerAllTools } from "../tools/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8"),
) as {
  name: string;
  version: string;
};

export { pkg };

export interface AppContext {
  qdrant: QdrantManager;
  embeddings: ReturnType<typeof EmbeddingProviderFactory.createFromEnv>;
  codeIndexer: CodeIndexer;
}

export function createAppContext(config: AppConfig): AppContext {
  const qdrant = new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
  const embeddings = EmbeddingProviderFactory.createFromEnv();
  const codeIndexer = new CodeIndexer(qdrant, embeddings, config.code);
  return { qdrant, embeddings, codeIndexer };
}

export function loadPrompts(config: AppConfig): PromptsConfig | null {
  if (!existsSync(config.promptsConfigFile)) return null;
  try {
    const promptsConfig = loadPromptsConfig(config.promptsConfigFile);
    console.error(
      `Loaded ${promptsConfig.prompts.length} prompts from ${config.promptsConfigFile}`,
    );
    return promptsConfig;
  } catch (error) {
    console.error(
      `Failed to load prompts configuration from ${config.promptsConfigFile}:`,
      error,
    );
    process.exit(1);
  }
}

export function createConfiguredServer(
  ctx: AppContext,
  promptsConfig: PromptsConfig | null,
): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  registerAllTools(server, {
    qdrant: ctx.qdrant,
    embeddings: ctx.embeddings,
    codeIndexer: ctx.codeIndexer,
  });

  registerAllResources(server, ctx.qdrant);
  registerAllPrompts(server, promptsConfig);

  return server;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/factory.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/server/factory.ts src/server/factory.test.ts
git commit -m "refactor: extract DI wiring and MCP server creation into server/factory.ts"
```

---

## Task 5: Create `src/transport/stdio.ts` and `src/transport/http.ts`

**Files:**

- Create: `src/transport/stdio.ts`
- Create: `src/transport/http.ts`
- Modify: `src/transport.test.ts` — update imports if needed

**Step 1: Write `src/transport/stdio.ts`**

```typescript
// src/transport/stdio.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Qdrant MCP server running on stdio");
}
```

**Step 2: Write `src/transport/http.ts`**

Move entire HTTP server from `src/index.ts` lines 216-411. Function signature:

```typescript
// src/transport/http.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Bottleneck from "bottleneck";
import express from "express";

import type { AppConfig } from "../config/env.js";
import type { PromptsConfig } from "../prompts/index.js";
import {
  createConfiguredServer,
  pkg,
  type AppContext,
} from "../server/factory.js";

interface HttpServerDeps {
  config: AppConfig;
  ctx: AppContext;
  promptsConfig: PromptsConfig | null;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<void> {
  const { config, ctx, promptsConfig } = deps;

  // Constants
  const RATE_LIMIT_MAX_REQUESTS = 100;
  const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
  const RATE_LIMIT_MAX_CONCURRENT = 10;
  const RATE_LIMITER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  const SHUTDOWN_GRACE_PERIOD_MS = 10 * 1000;

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.set("trust proxy", true);

  // Rate limiter group
  const rateLimiterGroup = new Bottleneck.Group({
    reservoir: RATE_LIMIT_MAX_REQUESTS,
    reservoirRefreshAmount: RATE_LIMIT_MAX_REQUESTS,
    reservoirRefreshInterval: RATE_LIMIT_WINDOW_MS,
    maxConcurrent: RATE_LIMIT_MAX_CONCURRENT,
  });

  const sendErrorResponse = (
    res: express.Response,
    code: number,
    message: string,
    httpStatus = 500,
  ) => {
    if (!res.headersSent) {
      res.status(httpStatus).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      });
    }
  };

  // IP cleanup tracking
  const ipLastAccess = new Map<string, number>();

  const cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    const keysToDelete: string[] = [];

    ipLastAccess.forEach((lastAccess, ip) => {
      if (now - lastAccess > RATE_LIMITER_CLEANUP_INTERVAL_MS) {
        keysToDelete.push(ip);
      }
    });

    keysToDelete.forEach((ip) => {
      void rateLimiterGroup.deleteKey(ip);
      ipLastAccess.delete(ip);
    });

    if (keysToDelete.length > 0) {
      console.error(`Cleaned up ${keysToDelete.length} inactive rate limiters`);
    }
  }, RATE_LIMITER_CLEANUP_INTERVAL_MS);

  // Rate limiting middleware
  const rateLimitMiddleware = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";

    try {
      ipLastAccess.set(clientIp, Date.now());
      const limiter = rateLimiterGroup.key(clientIp);
      await limiter.schedule(async () => Promise.resolve());
      next();
    } catch (error) {
      if (error instanceof Bottleneck.BottleneckError) {
        console.error(`Rate limit exceeded for IP ${clientIp}:`, error.message);
      } else {
        console.error("Unexpected rate limiting error:", error);
      }
      sendErrorResponse(res, -32000, "Too many requests", 429);
    }
  };

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: config.transportMode,
      version: pkg.version,
      embedding_provider: config.embeddingProvider,
    });
  });

  // MCP endpoint
  app.post("/mcp", rateLimitMiddleware, async (req, res) => {
    const requestServer = createConfiguredServer(ctx, promptsConfig);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await transport.close().catch(() => {});
      await requestServer.close().catch(() => {});
    };

    const timeoutId = setTimeout(() => {
      sendErrorResponse(res, -32000, "Request timeout", 504);
      cleanup().catch((err) => {
        console.error("Error during timeout cleanup:", err);
      });
    }, config.requestTimeoutMs);

    try {
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      const cleanupHandler = () => {
        clearTimeout(timeoutId);
        cleanup().catch((err) => {
          console.error("Error during response cleanup:", err);
        });
      };

      res.on("finish", cleanupHandler);
      res.on("close", cleanupHandler);
      res.on("error", (err) => {
        console.error("Response stream error:", err);
        cleanupHandler();
      });
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("Error handling MCP request:", error);
      sendErrorResponse(res, -32603, "Internal server error");
      await cleanup();
    }
  });

  const httpServer = app
    .listen(config.httpPort, () => {
      console.error(
        `Qdrant MCP server running on http://localhost:${config.httpPort}/mcp`,
      );
    })
    .on("error", (error) => {
      console.error("HTTP server error:", error);
      process.exit(1);
    });

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.error(
      "Shutdown signal received, closing HTTP server gracefully...",
    );
    clearInterval(cleanupIntervalId);

    const forceTimeout = setTimeout(() => {
      console.error("Forcing shutdown after timeout");
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);

    httpServer.close(() => {
      clearTimeout(forceTimeout);
      console.error("HTTP server closed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
```

**Step 3: Verify `transport.test.ts` still passes**

The existing `src/transport.test.ts` tests validation logic and mock patterns —
it does not import from `src/index.ts`. It should pass unchanged.

Run: `npx vitest run src/transport.test.ts` Expected: PASS (no import changes
needed)

**Step 4: Commit**

```bash
git add src/transport/stdio.ts src/transport/http.ts
git commit -m "refactor: extract stdio and HTTP transports into transport/ domain"
```

---

## Task 6: Rewrite `src/index.ts` as Thin Entry-Point

**Files:**

- Modify: `src/index.ts` (replace entirely)

**Step 1: Rewrite index.ts**

Replace entire contents of `src/index.ts` with:

```typescript
#!/usr/bin/env node
import { parseAppConfig } from "./config/env.js";
import { validateConfig } from "./config/validate.js";
import { checkOllamaAvailability } from "./providers/ollama-check.js";
import {
  createAppContext,
  createConfiguredServer,
  loadPrompts,
} from "./server/factory.js";
import { startHttpServer } from "./transport/http.js";
import { startStdioServer } from "./transport/stdio.js";

async function main() {
  const config = parseAppConfig();
  validateConfig(config);
  await checkOllamaAvailability(config.embeddingProvider);

  const ctx = createAppContext(config);
  const promptsConfig = loadPrompts(config);

  if (config.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    await startStdioServer(server);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

**Step 2: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 3: Type-check**

Run: `npx tsc --noEmit` Expected: No errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: slim index.ts to thin entry-point (428 -> ~25 lines)"
```

---

## Task 7: Create `src/tools/formatters/enrichment.ts` — Deduplicate Enrichment Status

**Files:**

- Create: `src/tools/formatters/enrichment.ts`
- Test: `src/tools/formatters/enrichment.test.ts`
- Modify: `src/tools/code.ts`

**Step 1: Write the failing test**

```typescript
// src/tools/formatters/enrichment.test.ts
import { describe, expect, it, vi } from "vitest";

import { formatEnrichmentStatus } from "./enrichment.js";

describe("formatEnrichmentStatus", () => {
  it("should return empty string for skipped enrichment", async () => {
    const result = await formatEnrichmentStatus(
      "skipped",
      undefined,
      undefined,
      "",
    );
    expect(result).toBe("");
  });

  it("should return empty string for undefined enrichment", async () => {
    const result = await formatEnrichmentStatus(
      undefined,
      undefined,
      undefined,
      "",
    );
    expect(result).toBe("");
  });

  it("should format completed enrichment with duration", async () => {
    const result = await formatEnrichmentStatus(
      "completed",
      5000,
      undefined,
      "",
    );
    expect(result).toContain("Git enrichment: completed");
    expect(result).toContain("5.0s");
  });

  it("should format background enrichment with progress from getIndexStatus", async () => {
    const mockGetStatus = vi.fn().mockResolvedValue({
      enrichment: {
        status: "in_progress",
        percentage: 42,
        matchedFiles: 80,
        missedFiles: 20,
        gitLogFileCount: 150,
      },
    });

    const result = await formatEnrichmentStatus(
      "background",
      undefined,
      mockGetStatus,
      "/my/path",
    );
    expect(result).toContain("in_progress");
    expect(result).toContain("42%");
    expect(result).toContain("80%"); // coverage rate
    expect(result).toContain("80/100"); // matched/total
    expect(result).toContain("150 files");
  });

  it("should handle getIndexStatus failure gracefully for background", async () => {
    const mockGetStatus = vi.fn().mockRejectedValue(new Error("fail"));

    const result = await formatEnrichmentStatus(
      "background",
      undefined,
      mockGetStatus,
      "/my/path",
    );
    expect(result).toContain("background");
    expect(result).toContain("get_index_status");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/formatters/enrichment.test.ts` Expected: FAIL —
module not found

**Step 3: Write minimal implementation**

Extract the duplicated logic from `src/tools/code.ts`:

```typescript
// src/tools/formatters/enrichment.ts
import type { EnrichmentInfo, IndexStatus } from "../../code/types.js";

type GetIndexStatusFn = (path: string) => Promise<IndexStatus>;

export async function formatEnrichmentStatus(
  enrichmentStatus: string | undefined,
  enrichmentDurationMs: number | undefined,
  getIndexStatus: GetIndexStatusFn | undefined,
  path: string,
): Promise<string> {
  if (!enrichmentStatus || enrichmentStatus === "skipped") {
    return "";
  }

  if (enrichmentStatus === "background") {
    return formatBackgroundEnrichment(getIndexStatus, path);
  }

  let message = `\nGit enrichment: ${enrichmentStatus}`;
  if (enrichmentDurationMs) {
    message += ` (${(enrichmentDurationMs / 1000).toFixed(1)}s)`;
  }
  return message;
}

async function formatBackgroundEnrichment(
  getIndexStatus: GetIndexStatusFn | undefined,
  path: string,
): Promise<string> {
  if (!getIndexStatus) {
    return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
  }

  try {
    const currentStatus = await getIndexStatus(path);
    if (!currentStatus.enrichment) {
      return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
    }

    return formatEnrichmentInfo(currentStatus.enrichment);
  } catch {
    return "\n\n[Git enrichment is running in background. Use get_index_status to track progress.]";
  }
}

function formatEnrichmentInfo(e: EnrichmentInfo): string {
  let message = `\n\nGit enrichment: ${e.status}`;

  if (e.percentage !== undefined) message += ` (${e.percentage}%)`;

  if (e.matchedFiles !== undefined && e.missedFiles !== undefined) {
    const total = e.matchedFiles + e.missedFiles;
    const rate = total > 0 ? Math.round((e.matchedFiles / total) * 100) : 0;
    message += `\nGit metadata coverage: ${rate}% (${e.matchedFiles}/${total} indexed files)`;

    if (e.gitLogFileCount !== undefined) {
      message += `\nGit log contains ${e.gitLogFileCount} files (GIT_LOG_MAX_AGE_MONTHS window)`;
    }

    if (rate < 80 && e.missedFiles > 0) {
      message += `\nHint: Low coverage is normal for mature codebases. Increase GIT_LOG_MAX_AGE_MONTHS for broader coverage.`;
    }
  }

  if (e.status !== "completed") {
    message += `\n[Use get_index_status to track progress.]`;
  }

  return message;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/formatters/enrichment.test.ts` Expected: PASS

**Step 5: Update `src/tools/code.ts` to use the formatter**

Replace the duplicated blocks in `index_codebase` handler (lines 40-73) and
`reindex_changes` handler (lines 192-225) with:

```typescript
import { formatEnrichmentStatus } from "./formatters/enrichment.js";

// In both handlers, replace the enrichment formatting blocks with:
const enrichmentMessage = await formatEnrichmentStatus(
  stats.enrichmentStatus,
  stats.enrichmentDurationMs,
  (p) => codeIndexer.getIndexStatus(p),
  path,
);
statusMessage += enrichmentMessage;
```

**Step 6: Run tests**

Run: `npx vitest run` Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/tools/formatters/enrichment.ts src/tools/formatters/enrichment.test.ts src/tools/code.ts
git commit -m "refactor: extract enrichment status formatter, remove duplication in code.ts"
```

---

## Task 8: Create `src/tools/formatters/search-pipeline.ts` — Deduplicate Search Logic

**Files:**

- Create: `src/tools/formatters/search-pipeline.ts`
- Test: `src/tools/formatters/search-pipeline.test.ts`
- Modify: `src/tools/search.ts`

**Step 1: Write the failing test**

```typescript
// src/tools/formatters/search-pipeline.test.ts
import { describe, expect, it } from "vitest";

import {
  applyPostProcessing,
  formatSearchResults,
  resolveCollectionName,
} from "./search-pipeline.js";

describe("resolveCollectionName", () => {
  it("should return collection if provided", () => {
    const result = resolveCollectionName("my-collection", undefined);
    expect(result).toEqual({ collectionName: "my-collection" });
  });

  it("should resolve from path if collection not provided", () => {
    const result = resolveCollectionName(undefined, "/my/project");
    expect(result).toHaveProperty("collectionName");
    expect((result as any).collectionName).toMatch(/^code_/);
  });

  it("should return error if neither provided", () => {
    const result = resolveCollectionName(undefined, undefined);
    expect(result).toHaveProperty("error");
  });
});

describe("applyPostProcessing", () => {
  const mockResults = [
    { id: "1", score: 0.95, payload: { relativePath: "src/a.ts" } },
    { id: "2", score: 0.9, payload: { relativePath: "lib/b.ts" } },
    { id: "3", score: 0.85, payload: { relativePath: "src/c.ts" } },
  ];

  it("should trim to limit", () => {
    const result = applyPostProcessing(mockResults, { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("should apply pathPattern filter", () => {
    const result = applyPostProcessing(mockResults, {
      pathPattern: "src/**",
      limit: 10,
    });
    expect(result).toHaveLength(2);
    expect(
      result.every((r) => r.payload?.relativePath?.startsWith("src/")),
    ).toBe(true);
  });
});

describe("formatSearchResults", () => {
  it("should format full results as JSON", () => {
    const results = [{ id: "1", score: 0.9, payload: { content: "test" } }];
    const output = formatSearchResults(results, false);
    expect(output.content[0].text).toContain('"score"');
  });

  it("should format metaOnly results", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          startLine: 1,
          endLine: 10,
          language: "typescript",
          chunkType: "function",
          name: "foo",
          imports: ["bar"],
          git: { dominantAuthor: "John" },
          content: "should not appear",
        },
      },
    ];
    const output = formatSearchResults(results, true);
    const parsed = JSON.parse(output.content[0].text);
    expect(parsed[0]).not.toHaveProperty("content");
    expect(parsed[0]).toHaveProperty("relativePath");
    expect(parsed[0]).toHaveProperty("git");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/formatters/search-pipeline.test.ts` Expected:
FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/tools/formatters/search-pipeline.ts
import { CodeIndexer } from "../../code/indexer.js";
import {
  rerankSemanticSearchResults,
  type RerankMode,
  type SemanticSearchRerankPreset,
} from "../../code/reranker.js";
import {
  calculateFetchLimit,
  filterResultsByGlob,
} from "../../qdrant/filters/index.js";

interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, any>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export function resolveCollectionName(
  collection?: string,
  path?: string,
): { collectionName: string } | { error: ToolResult } {
  if (!collection && !path) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: "Error: Either 'collection' or 'path' parameter is required.",
          },
        ],
        isError: true,
      },
    };
  }
  return {
    collectionName: collection || CodeIndexer.resolveCollectionName(path ?? ""),
  };
}

export function getSearchFetchLimit(
  requestedLimit: number | undefined,
  pathPattern?: string,
  rerank?: unknown,
): { requestedLimit: number; fetchLimit: number } {
  const limit = requestedLimit || 5;
  const needsOverfetch =
    Boolean(pathPattern) || Boolean(rerank && rerank !== "relevance");
  return {
    requestedLimit: limit,
    fetchLimit: calculateFetchLimit(limit, needsOverfetch),
  };
}

export function applyPostProcessing(
  results: SearchResult[],
  options: { pathPattern?: string; rerank?: unknown; limit: number },
): SearchResult[] {
  let filtered = options.pathPattern
    ? filterResultsByGlob(results, options.pathPattern)
    : results;

  if (options.rerank && options.rerank !== "relevance") {
    filtered = rerankSemanticSearchResults(
      filtered,
      options.rerank as RerankMode<SemanticSearchRerankPreset>,
    );
  }

  return filtered.slice(0, options.limit);
}

export function formatSearchResults(
  results: SearchResult[],
  metaOnly?: boolean,
): ToolResult {
  if (metaOnly) {
    const metaResults = results.map((r) => ({
      score: r.score,
      relativePath: r.payload?.relativePath,
      startLine: r.payload?.startLine,
      endLine: r.payload?.endLine,
      language: r.payload?.language,
      chunkType: r.payload?.chunkType,
      name: r.payload?.name,
      imports: r.payload?.imports,
      git: r.payload?.git,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(metaResults, null, 2) }],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}

export async function validateCollectionExists(
  qdrant: { collectionExists: (name: string) => Promise<boolean> },
  collectionName: string,
  path?: string,
): Promise<ToolResult | null> {
  const exists = await qdrant.collectionExists(collectionName);
  if (!exists) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Collection "${collectionName}" does not exist.${path ? ` Codebase at "${path}" may not be indexed.` : ""}`,
        },
      ],
      isError: true,
    };
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/formatters/search-pipeline.test.ts` Expected:
PASS

**Step 5: Update `src/tools/search.ts` to use pipeline**

Rewrite `semantic_search` and `hybrid_search` handlers as thin wrappers:

```typescript
// src/tools/search.ts — rewritten
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EmbeddingProvider } from "../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../embeddings/sparse.js";
import type { QdrantManager } from "../qdrant/client.js";
import {
  applyPostProcessing,
  formatSearchResults,
  getSearchFetchLimit,
  resolveCollectionName,
  validateCollectionExists,
} from "./formatters/search-pipeline.js";
import * as schemas from "./schemas.js";

export interface SearchToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
}

export function registerSearchTools(
  server: McpServer,
  deps: SearchToolDependencies,
): void {
  const { qdrant, embeddings } = deps;

  // semantic_search
  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Search for documents using natural language queries. Returns the most semantically similar documents.",
      inputSchema: schemas.SemanticSearchSchema,
    },
    async ({
      collection,
      path,
      query,
      limit,
      filter,
      pathPattern,
      rerank,
      metaOnly,
    }) => {
      const resolved = resolveCollectionName(collection, path);
      if ("error" in resolved) return resolved.error;

      const collectionError = await validateCollectionExists(
        qdrant,
        resolved.collectionName,
        path,
      );
      if (collectionError) return collectionError;

      const { embedding } = await embeddings.embed(query);
      const limits = getSearchFetchLimit(limit, pathPattern, rerank);
      const results = await qdrant.search(
        resolved.collectionName,
        embedding,
        limits.fetchLimit,
        filter,
      );
      const processed = applyPostProcessing(results, {
        pathPattern,
        rerank,
        limit: limits.requestedLimit,
      });

      return formatSearchResults(processed, metaOnly);
    },
  );

  // hybrid_search
  server.registerTool(
    "hybrid_search",
    {
      title: "Hybrid Search",
      description:
        "Perform hybrid search combining semantic vector search with keyword search using BM25. This provides better results by combining the strengths of both approaches. The collection must be created with enableHybrid set to true.",
      inputSchema: schemas.HybridSearchSchema,
    },
    async ({
      collection,
      path,
      query,
      limit,
      filter,
      pathPattern,
      rerank,
      metaOnly,
    }) => {
      const resolved = resolveCollectionName(collection, path);
      if ("error" in resolved) return resolved.error;

      const collectionError = await validateCollectionExists(
        qdrant,
        resolved.collectionName,
        path,
      );
      if (collectionError) return collectionError;

      // Check hybrid support
      const collectionInfo = await qdrant.getCollectionInfo(
        resolved.collectionName,
      );
      if (!collectionInfo.hybridEnabled) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Collection "${resolved.collectionName}" does not have hybrid search enabled. Create a new collection with enableHybrid set to true.`,
            },
          ],
          isError: true,
        };
      }

      const { embedding } = await embeddings.embed(query);
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      const limits = getSearchFetchLimit(limit, pathPattern, rerank);
      const results = await qdrant.hybridSearch(
        resolved.collectionName,
        embedding,
        sparseVector,
        limits.fetchLimit,
        filter,
      );
      const processed = applyPostProcessing(results, {
        pathPattern,
        rerank,
        limit: limits.requestedLimit,
      });

      return formatSearchResults(processed, metaOnly);
    },
  );
}
```

**Step 6: Run all tests**

Run: `npx vitest run` Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/tools/formatters/search-pipeline.ts src/tools/formatters/search-pipeline.test.ts src/tools/search.ts
git commit -m "refactor: extract search pipeline, remove duplication in search.ts"
```

---

## Task 9: Final Verification & Cleanup

**Step 1: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 2: Type-check**

Run: `npx tsc --noEmit` Expected: No errors

**Step 3: Lint**

Run: `npm run lint` Expected: No errors (or only pre-existing ones)

**Step 4: Build**

Run: `npm run build` Expected: Build succeeds

**Step 5: Verify file sizes meet criteria**

- `src/index.ts` should be < 30 lines
- No new file > 180 lines
- No duplicated code blocks > 10 lines

**Step 6: Final commit (if any fixups)**

```bash
git add -A
git commit -m "refactor: SRP refactoring — final cleanup and verification"
```
