import { describe, expect, it, vi } from "vitest";

import {
  assertRequestedLanguagesPresent,
  LanguageNotInIndexError,
  type LanguagePresencePorts,
} from "../../../../../src/core/api/internal/ops/language-presence-guard.js";
import { InputValidationError } from "../../../../../src/core/api/public/errors.js";

const SUPPORTED = ["typescript", "ruby", "python", "markdown"];

function ports(held: Record<string, number>, tree: readonly string[] = []): LanguagePresencePorts {
  return {
    countIndexed: vi.fn(async (language: string) => held[language] ?? 0),
    languagesInTree: vi.fn(async (languages: readonly string[]) => languages.filter((l) => tree.includes(l))),
  };
}

async function failure(promise: Promise<void>): Promise<LanguageNotInIndexError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LanguageNotInIndexError);
  return error as LanguageNotInIndexError;
}

describe("assertRequestedLanguagesPresent", () => {
  it("rejects a single language the index does not hold and names the languages it does", async () => {
    const error = await failure(
      assertRequestedLanguagesPresent(["ruby"], SUPPORTED, ports({ typescript: 40, markdown: 3 }), {
        scopeToTree: false,
      }),
    );
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toMatch(/ruby/);
    expect(error.message).toMatch(/typescript/);
    expect(error.message).toMatch(/markdown/);
    expect(error.message).not.toMatch(/python/);
  });

  it("rejects a partial match, listing absent and held requested languages", async () => {
    const error = await failure(
      assertRequestedLanguagesPresent(["typescript", "ruby"], SUPPORTED, ports({ typescript: 40 }), {
        scopeToTree: false,
      }),
    );
    expect(error.message).toMatch(/ruby/);
    expect(error.message).toMatch(/typescript/);
    expect(error.absent).toEqual(["ruby"]);
    expect(error.held).toEqual(["typescript"]);
  });

  it("passes when every requested language is held, in any casing", async () => {
    await expect(
      assertRequestedLanguagesPresent(["TypeScript", " ruby"], SUPPORTED, ports({ typescript: 1, ruby: 2 }), {
        scopeToTree: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("counts held languages only on the failure path", async () => {
    const p = ports({ typescript: 1 });
    await assertRequestedLanguagesPresent(["typescript"], SUPPORTED, p, { scopeToTree: false });
    expect(p.countIndexed).toHaveBeenCalledTimes(1);
  });

  it("scoped force: a language absent from the index but present in the tree passes", async () => {
    await expect(
      assertRequestedLanguagesPresent(["ruby"], SUPPORTED, ports({ typescript: 5 }, ["ruby"]), { scopeToTree: true }),
    ).resolves.toBeUndefined();
  });

  it("scoped force: absent from both index and tree is rejected", async () => {
    const error = await failure(
      assertRequestedLanguagesPresent(["ruby"], SUPPORTED, ports({ typescript: 5 }, []), { scopeToTree: true }),
    );
    expect(error.absent).toEqual(["ruby"]);
  });
});
