import { describe, expect, it } from "vitest";

import { validateLanguages } from "../../../src/core/api/internal/facades/ingest-facade.js";
import type { IndexOptions } from "../../../src/core/api/public/dto/ingest.js";

const SUPPORTED = ["typescript", "ruby", "python"];

function options(over: Partial<IndexOptions>): IndexOptions {
  return over as IndexOptions;
}

/** The rejection message, so a test can assert on what it names. */
function refusalMessage(opts: IndexOptions): string {
  try {
    validateLanguages(opts, SUPPORTED);
    return "";
  } catch (err) {
    const { message } = err as Error;
    return message;
  }
}

describe("validateLanguages", () => {
  it("accepts a run that names no languages at all", () => {
    expect(() => {
      validateLanguages(options({}), SUPPORTED);
    }).not.toThrow();
  });

  it("accepts languages alongside a provider recompute", () => {
    expect(() => {
      validateLanguages(options({ languages: ["typescript"], forceEnrichments: ["git"] }), SUPPORTED);
    }).not.toThrow();
  });

  it("accepts languages alongside a full reindex", () => {
    expect(() => {
      validateLanguages(options({ languages: ["ruby"], forceReindex: true }), SUPPORTED);
    }).not.toThrow();
  });

  it("refuses languages on a plain incremental run", () => {
    // An incremental run's scope is already the changed-file set. Narrowing it
    // further only hides files the sync existed to catch up on.
    expect(() => {
      validateLanguages(options({ languages: ["ruby"] }), SUPPORTED);
    }).toThrow(/incremental/i);
  });

  it("refuses an empty language list", () => {
    expect(() => {
      validateLanguages(options({ languages: [], forceReindex: true }), SUPPORTED);
    }).toThrow(/at least one/i);
  });

  it("refuses an unsupported language and names what is supported", () => {
    const message = refusalMessage(options({ languages: ["cobol"], forceReindex: true }));
    expect(message).toMatch(/cobol/);
    expect(message).toMatch(/typescript/);
  });

  it("reports every unsupported language, not just the first", () => {
    const message = refusalMessage(options({ languages: ["cobol", "fortran"], forceReindex: true }));
    expect(message).toMatch(/cobol/);
    expect(message).toMatch(/fortran/);
  });

  it("accepts a language written in prose casing", () => {
    expect(() => {
      validateLanguages(options({ languages: ["TypeScript"], forceReindex: true }), SUPPORTED);
    }).not.toThrow();
  });
});
