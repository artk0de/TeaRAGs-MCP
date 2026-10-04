/**
 * The temporal facade builds its hook through the cochange facade (bd
 * tea-rags-mcp-0e4vf): `temporal/index.ts` imports `./cochange/index.js`,
 * never the `builder.ts` file behind it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TemporalCochangeBuilder } from "../../../../../../src/core/domains/trajectory/codegraph/temporal/cochange/index.js";
import {
  createTemporalCochangeHooks,
  TemporalCochangeBuilder as FacadeTemporalCochangeBuilder,
} from "../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import * as TemporalFacade from "../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import {
  DEFAULT_COCHANGE_PARTNERS_LIMIT,
  rankCochangePartners,
} from "../../../../../../src/core/domains/trajectory/codegraph/temporal/partners/index.js";

const TEMPORAL_FACADE = "../../../../../../src/core/domains/trajectory/codegraph/temporal/index.ts";

describe("temporal facade contract (bd tea-rags-mcp-0e4vf)", () => {
  it("imports the builder through the cochange facade, not the file", () => {
    const source = readFileSync(new URL(TEMPORAL_FACADE, import.meta.url), "utf8");
    expect(source).not.toContain('from "./cochange/builder.js"');
    expect(source).toContain('from "./cochange/index.js"');
  });

  it("exposes the builder from the facade as the very class the module defines", () => {
    expect(typeof FacadeTemporalCochangeBuilder).toBe("function");
    expect(FacadeTemporalCochangeBuilder).toBe(TemporalCochangeBuilder);
  });

  it("still builds the completion hook through the facade import", () => {
    expect(createTemporalCochangeHooks(undefined)).toEqual([]);

    const hooks = createTemporalCochangeHooks({
      windowMonths: 6,
      sessionGapMinutes: null,
      vcsAdapter: "git",
      gitTimeoutMs: 5_000,
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toBeInstanceOf(TemporalCochangeBuilder);
  });
});

describe("temporal facade surface (bd tea-rags-mcp-89k7k.24)", () => {
  it("exports the co-change ranking names the read ops reached past the facade for", () => {
    expect(TemporalFacade.DEFAULT_COCHANGE_PARTNERS_LIMIT).toBe(DEFAULT_COCHANGE_PARTNERS_LIMIT);
    expect(TemporalFacade.rankCochangePartners).toBe(rankCochangePartners);
  });

  it("re-exports them through the partners barrel, not the file behind it", () => {
    const source = readFileSync(new URL(TEMPORAL_FACADE, import.meta.url), "utf8");
    expect(source).toMatch(/export\s+\{[^}]*DEFAULT_COCHANGE_PARTNERS_LIMIT[^}]*\}\s*from\s*"\.\/partners\/index\.js"/);
    expect(source).toMatch(/export\s+\{[^}]*rankCochangePartners[^}]*\}\s*from\s*"\.\/partners\/index\.js"/);
    expect(source).not.toContain('from "./partners/partners.js"');
  });
});
