---
title: Adding Embedding Providers
sidebar_position: 1
---

# Adding Embedding Providers

How to add a new embedding provider (e.g. a new cloud API, a different local runtime, or a private in-house model service). Five providers ship built-in — ONNX, Ollama, OpenAI, Cohere, Voyage — all implementing the same contract.

## The `EmbeddingProvider` Interface

Source: `src/core/adapters/embeddings/base.ts`

```ts
interface EmbeddingProvider {
  embed: (text: string) => Promise<EmbeddingResult>;
  embedBatch: (texts: string[]) => Promise<EmbeddingResult[]>;
  getDimensions: () => number;
  getModel: () => string;
  /** Lightweight health check — returns true if provider is reachable. */
  checkHealth: () => Promise<boolean>;
  /** Provider identifier (e.g. "ollama", "onnx", "openai"). */
  getProviderName: () => string;
  /** Base URL for remote providers. Undefined for local (e.g. ONNX). */
  getBaseUrl?: () => string;
  /** Resolve model capabilities (context length, dimensions) from provider API. */
  resolveModelInfo?: () => Promise<{ model: string; contextLength: number; dimensions: number } | undefined>;
}
```

Required methods: `embed`, `embedBatch`, `getDimensions`, `getModel`, `checkHealth`, `getProviderName`.

Optional: `getBaseUrl` (for remote APIs), `resolveModelInfo` (for model-aware sizing).

## Implementation Checklist

### 1. Create the adapter class

Place under `src/core/adapters/embeddings/{provider-name}.ts`. Mirror the existing cloud adapters (OpenAI is the simplest template).

```ts
// src/core/adapters/embeddings/acme.ts
import Bottleneck from "bottleneck";
import { EmbeddingProvider, EmbeddingResult, RateLimitConfig } from "./base.js";
import { retryWithBackoff } from "./retry.js";
import { AcmeRateLimitError, AcmeAuthError } from "./acme/errors.js";

export class AcmeEmbeddings implements EmbeddingProvider {
  private readonly limiter: Bottleneck;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly dimensions: number,
    private readonly rateLimit: RateLimitConfig,
    private readonly baseUrl = "https://api.acme.example.com/v1",
  ) {
    this.limiter = new Bottleneck({
      reservoir: rateLimit.maxRequestsPerMinute,
      reservoirRefreshAmount: rateLimit.maxRequestsPerMinute,
      reservoirRefreshInterval: 60_000,
    });
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this.retryWithBackoff(() => this.limiter.schedule(() => this.rawEmbed(texts)));
  }

  getDimensions() { return this.dimensions; }
  getModel()      { return this.model; }
  getProviderName() { return "acme"; }
  getBaseUrl()    { return this.baseUrl; }

  async checkHealth() {
    try { await this.rawEmbed(["health check"]); return true; }
    catch { return false; }
  }

  // ── Private ────────────────────────────────────────────
  private async rawEmbed(texts: string[]): Promise<EmbeddingResult[]> { /* HTTP call */ }
  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> { /* see existing retry.ts */ }
}
```

### 2. Register in the factory

Edit `src/core/adapters/embeddings/factory.ts` → `EmbeddingProviderFactory.create`:

```ts
case "acme":
  if (!config.acmeApiKey) {
    throw new ConfigValueMissingError("apiKey", "ACME_API_KEY");
  }
  return new AcmeEmbeddings(
    config.acmeApiKey,
    model || "acme-embed-v1",
    dimensions,
    rateLimitConfig,
  );
```

Add `"acme"` to the `ConfigValueInvalidError` allowed-values list at the bottom of the switch.

### 3. Wire the config

Edit `src/bootstrap/config/parse.ts` to read `ACME_API_KEY` → `EmbeddingConfig.acmeApiKey`. Follow the pattern for `openaiApiKey`, `cohereApiKey`, etc.

Add `EMBEDDING_PROVIDER=acme` to the allowed enum in `src/core/contracts/types/config.ts`.

### 4. Typed errors

Create `src/core/adapters/embeddings/acme/errors.ts` with at minimum:

- `AcmeRateLimitError extends InfraError` with code `INFRA_EMBEDDING_ACME_RATE_LIMIT`
- `AcmeAuthError extends InfraError` with code `INFRA_EMBEDDING_ACME_AUTH`

Follow the exact pattern of `src/core/adapters/embeddings/openai/errors.ts`. Error codes are how the agent surfaces provider problems to users — don't skip this.

### 5. Default batch size + rate limit

Add your provider's tuned defaults to `src/bootstrap/config/defaults.ts`:

- `batchSize` — API-limited texts per request (e.g. Cohere = 96, OpenAI = 2048)
- `maxRequestsPerMinute` — provider's RPM tier

Users override via `EMBEDDING_TUNE_BATCH_SIZE` and `EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE`.

### 6. Tests

Place under `tests/core/adapters/embeddings/acme.test.ts`. Mock the HTTP client with `msw` or `vi.fn()`. Cover:

- Successful batch embed → returns array of vectors with correct dimensions
- Rate-limit 429 → retries after `Retry-After` header
- Auth 401 → throws `AcmeAuthError` (no retry)
- Health check reachable / unreachable

Follow `tests/core/adapters/embeddings/openai.test.ts` as template.

### 7. Documentation

Add a new page under `website/docs/config/providers/acme.md` mirroring the structure of `openai.md`: type/price/scale table, setup, configuration, available models, rate limits, when to use.

Add a row to `website/docs/config/providers/index.md` comparison table.

## Local vs Remote

**Remote (cloud API)** — pattern used by OpenAI, Cohere, Voyage:

- HTTP client (`openai`, `cohere-ai`, raw fetch)
- Rate limiter via `bottleneck`
- Retry with `Retry-After` honouring
- `getBaseUrl()` returns configured endpoint
- Typed errors for rate-limit / auth / quota

**Local (on-device)** — pattern used by ONNX, Ollama:

- Process/daemon lifecycle management
- No rate limiting (backpressure via provider's own concurrency)
- Fallback behaviour if local service crashes (see `OllamaEmbeddings#switchToFallback`)
- `getBaseUrl()` returns `undefined` (ONNX) or local socket (`http://localhost:11434` for Ollama)

Copy the closest template to your situation.

## Testing the Integration End-to-End

After registration:

```bash
export EMBEDDING_PROVIDER=acme
export ACME_API_KEY=...
npm run build
# then in Claude Code, re-connect the MCP server and:
```

Call `index_codebase` with `forceReindex: true` on a small test directory. If the provider succeeds, you should see a new collection `{name}_{model}_{schemaVersion}` with the new dimensions. Confirm via `get_collection_info`.

If health check fails at startup, the agent will receive `INFRA_EMBEDDING_ACME_*` error codes — check they're mapped correctly in your `errors.ts`.

## Related

- [Embedding Providers Overview](/config/providers/) — user-facing provider comparison
- [Failure Model](/operations/failure-model) — how retries and fallbacks work
- [Data Model](/architecture/data-model) — what embeddings populate (the dense vector)
