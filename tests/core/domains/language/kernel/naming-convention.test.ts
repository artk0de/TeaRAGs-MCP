/**
 * The neutral half of naming-convention receiver typing (E2 seam 5, bd
 * tea-rags-mcp-9fgdi / 0g8g5). Relocated out of
 * `ruby/resolver/ruby-unbound-receiver-types.ts`, where the same three rules
 * were measured on taxdome as 11 % of the entire recall hole.
 *
 * Fake ports: the whole point of the relocation is that the gate does not know
 * which language asked, so the test states the gate and nothing else.
 */
import { describe, expect, it } from "vitest";

import {
  conventionClassNameFor,
  type NamingConventionPorts,
} from "../../../../../src/core/domains/language/kernel/naming-convention.js";

interface FakeCtx {
  readonly declared: ReadonlySet<string>;
  readonly bases: ReadonlySet<string>;
}

const ports: NamingConventionPorts<FakeCtx> = {
  camelize: (snake) =>
    snake
      .split("_")
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(""),
  classExists: (className, ctx) => ctx.declared.has(className),
  hasSubtypes: (className, ctx) => ctx.bases.has(className),
};

const ctxOf = (declared: string[], bases: string[] = []): FakeCtx => ({
  declared: new Set(declared),
  bases: new Set(bases),
});

describe("conventionClassNameFor", () => {
  it("answers the camelized class when it exists and has no subtypes", () => {
    expect(conventionClassNameFor("blog_post", ctxOf(["BlogPost"]), ports)).toBe("BlogPost");
  });

  it("is silent when the class does not exist", () => {
    expect(conventionClassNameFor("blog_post", ctxOf(["Post"]), ports)).toBeUndefined();
  });

  it("is silent when the class has subtypes", () => {
    expect(conventionClassNameFor("actor", ctxOf(["Actor"], ["Actor"]), ports)).toBeUndefined();
  });

  it("is silent on an empty camelization", () => {
    expect(conventionClassNameFor("_", ctxOf([""]), ports)).toBeUndefined();
  });

  it("does not ask about existence once the camelization is empty", () => {
    const asked: string[] = [];
    const recording: NamingConventionPorts<FakeCtx> = {
      ...ports,
      classExists: (className, ctx) => {
        asked.push(className);
        return ports.classExists(className, ctx);
      },
    };
    expect(conventionClassNameFor("__", ctxOf([]), recording)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("does not ask about subtypes once the class is unknown — the gates are ordered", () => {
    const asked: string[] = [];
    const recording: NamingConventionPorts<FakeCtx> = {
      ...ports,
      hasSubtypes: (className, ctx) => {
        asked.push(className);
        return ports.hasSubtypes(className, ctx);
      },
    };
    expect(conventionClassNameFor("payment", ctxOf([]), recording)).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
