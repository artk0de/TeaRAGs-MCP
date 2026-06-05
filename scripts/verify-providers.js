#!/usr/bin/env node

/**
 * Provider verification smoke check.
 *
 * Exercises EmbeddingProviderFactory against the compiled build to confirm the
 * factory rejects unknown providers, enforces API-key requirements, and applies
 * the expected default model/dimensions for each supported provider. Run via
 * `npm run test:providers` after `npm run build`.
 */
import { EmbeddingProviderFactory } from "../build/core/adapters/embeddings/factory.js";

const BASE_TUNE = {
  concurrency: 1,
  batchSize: 1024,
  batchTimeoutMs: 2000,
  retryAttempts: 3,
  retryDelayMs: 1000,
};

/** Build a provider config with sensible defaults, overlaid by `overrides`. */
const config = (overrides) => ({
  provider: "ollama",
  device: "auto",
  ollamaLegacyApi: false,
  ollamaNumGpu: 999,
  tune: BASE_TUNE,
  ...overrides,
});

/** Assert that creating a provider with `cfg` throws an error matching `pattern`. */
const expectRejected = (cfg, pattern) => {
  let created;
  try {
    created = EmbeddingProviderFactory.create(cfg);
  } catch (err) {
    if (!pattern.test(err.message)) {
      throw new Error(`rejected, but message did not match ${pattern}: ${err.message}`);
    }
    return;
  }
  throw new Error(`expected rejection but factory returned a provider: ${created?.getModel?.()}`);
};

/** Assert that `cfg` produces a provider with the given model and dimensions. */
const expectProvider = (cfg, { model, dimensions }) => {
  const provider = EmbeddingProviderFactory.create(cfg);
  if (!provider) throw new Error("factory returned a falsy provider");
  const actualModel = provider.getModel();
  if (actualModel !== model) throw new Error(`model: expected '${model}', got '${actualModel}'`);
  const actualDims = provider.getDimensions();
  if (actualDims !== dimensions) throw new Error(`dimensions: expected ${dimensions}, got ${actualDims}`);
};

const MISSING_KEY = /is not set|API key is required/;

const checks = [
  ["factory rejects unknown provider", () => expectRejected(config({ provider: "unknown-provider" }), /Invalid value|Unknown embedding provider/)],
  ["openai requires an API key", () => expectRejected(config({ provider: "openai" }), MISSING_KEY)],
  ["cohere requires an API key", () => expectRejected(config({ provider: "cohere" }), MISSING_KEY)],
  ["voyage requires an API key", () => expectRejected(config({ provider: "voyage" }), MISSING_KEY)],
  ["ollama needs no API key, applies code-embedding defaults", () =>
    expectProvider(config({ provider: "ollama" }), { model: "unclemusclez/jina-embeddings-v2-base-code:latest", dimensions: 768 })],
  ["openai applies its default model/dimensions", () =>
    expectProvider(config({ provider: "openai", openaiApiKey: "test-key-123" }), { model: "text-embedding-3-small", dimensions: 1536 })],
  ["cohere applies its default model/dimensions", () =>
    expectProvider(config({ provider: "cohere", cohereApiKey: "test-key-123" }), { model: "embed-english-v3.0", dimensions: 1024 })],
  ["voyage applies its default model/dimensions", () =>
    expectProvider(config({ provider: "voyage", voyageApiKey: "test-key-123" }), { model: "voyage-2", dimensions: 1024 })],
  ["a custom model overrides the default and its dimensions", () =>
    expectProvider(config({ provider: "openai", openaiApiKey: "test-key-123", model: "text-embedding-3-large" }), { model: "text-embedding-3-large", dimensions: 3072 })],
  ["an explicit dimensions value overrides the model default", () =>
    expectProvider(config({ provider: "openai", openaiApiKey: "test-key-123", dimensions: 512 }), { model: "text-embedding-3-small", dimensions: 512 })],
];

const failures = [];
for (const [name, run] of checks) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}

const total = checks.length;
const passed = total - failures.length;
console.log(`\n${passed}/${total} provider checks passed`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
