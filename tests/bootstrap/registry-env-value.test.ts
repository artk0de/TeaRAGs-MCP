/**
 * `assertRegistryEnvValueParses` (bd tea-rags-mcp-5uk75): a value set through
 * `tea-rags projects set-env` is checked against the SAME config schema the
 * next index run parses it with, so a bad value is refused at configuration
 * time instead of breaking every later run of that project.
 */
import { describe, expect, it } from "vitest";

import { assertRegistryEnvValueParses } from "../../src/bootstrap/config/parse.js";
import { ConfigValueInvalidError } from "../../src/core/infra/errors.js";

describe("assertRegistryEnvValueParses", () => {
  it("accepts values the config schema parses", () => {
    expect(() => {
      assertRegistryEnvValueParses("INGEST_CHUNK_SIZE", "2500");
    }).not.toThrow();
    expect(() => {
      assertRegistryEnvValueParses("CODE_CHUNK_SIZE", "2500");
    }).not.toThrow();
    expect(() => {
      assertRegistryEnvValueParses("GIT_ADAPTER", "git");
    }).not.toThrow();
  });

  it("refuses a value the config schema rejects", () => {
    expect(() => {
      assertRegistryEnvValueParses("INGEST_CHUNK_SIZE", "abc");
    }).toThrow(ConfigValueInvalidError);
    expect(() => {
      assertRegistryEnvValueParses("EMBEDDING_PROVIDER", "bogus");
    }).toThrow(ConfigValueInvalidError);
  });

  it("does not demand an API key for a provider switch — secrets are never persisted", () => {
    expect(() => {
      assertRegistryEnvValueParses("EMBEDDING_PROVIDER", "openai");
    }).not.toThrow();
  });
});
