/**
 * IngestFacade — input validation for `forceEnrichments`.
 *
 * Validation belongs to the facade (facade-discipline: validate + delegate).
 * A typo'd selector must be refused up front: a recompute that silently covers
 * a smaller set than intended is indistinguishable from a successful one once
 * the run finishes.
 */

import { describe, expect, it, vi } from "vitest";

import { validateForceEnrichments } from "../../../src/core/api/internal/facades/ingest-facade.js";

const AVAILABLE = ["git", "codegraph.symbols"];

describe("validateForceEnrichments", () => {
  it("accepts a known provider key", () => {
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["git"] }, AVAILABLE);
    }).not.toThrow();
  });

  it("accepts a namespace selector that matches registered providers", () => {
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["codegraph"] }, AVAILABLE);
    }).not.toThrow();
  });

  it("accepts the `all` selector", () => {
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["all"] }, AVAILABLE);
    }).not.toThrow();
  });

  it("rejects a selector that matches no registered provider", () => {
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["codegrap"] }, AVAILABLE);
    }).toThrow(/codegrap/);
  });

  it("names the registered providers in the rejection", () => {
    // The operator needs to see what they could have typed instead.
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["nope"] }, AVAILABLE);
    }).toThrow(/codegraph\.symbols/);
  });

  it("rejects combining it with a full reindex", () => {
    // A full reindex already rebuilds the enrichment layer, so the combination
    // means the caller misunderstood one of the two flags.
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["git"], forceReindex: true }, AVAILABLE);
    }).toThrow(/forceReindex/);
  });

  it("rejects an empty selector list", () => {
    expect(() => {
      validateForceEnrichments({ forceEnrichments: [] }, AVAILABLE);
    }).toThrow();
  });

  it("passes through when the option is absent", () => {
    expect(() => {
      validateForceEnrichments({}, AVAILABLE);
    }).not.toThrow();
    expect(() => {
      validateForceEnrichments({ forceReindex: true }, AVAILABLE);
    }).not.toThrow();
  });

  it("rejects every selector when no provider is registered at all", () => {
    expect(() => {
      validateForceEnrichments({ forceEnrichments: ["git"] }, []);
    }).toThrow();
  });

  it("does not consult the provider list when the option is absent", () => {
    const spy = vi.fn();
    expect(() => {
      validateForceEnrichments({}, new Proxy([], { get: spy }) as never);
    }).not.toThrow();
  });
});
