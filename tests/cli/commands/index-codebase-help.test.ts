/**
 * `index-codebase --languages` help text (bd tea-rags-mcp-l1ot.2 audit).
 *
 * Before bd tea-rags-mcp-j4oww the flag narrowed the WHOLE `--force` run —
 * chunking included — into a new collection holding only those languages. A
 * scoped force now re-chunks the selected languages IN PLACE and leaves every
 * other point alone; help text still describing the old behaviour would steer
 * a user away from the safe tool, or into believing it destroys the index.
 */

import { describe, expect, it } from "vitest";

import { indexCodebaseCommand } from "../../../src/cli/commands/index-codebase.js";

/** Drive the yargs builder and capture every option's declaration. */
function declaredOptions(): Map<string, { describe?: string }> {
  const options = new Map<string, { describe?: string }>();
  const fakeYargs: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, method: string) => (name: unknown, opts: unknown) => {
        if (method === "option" && typeof name === "string") options.set(name, opts as { describe?: string });
        return fakeYargs;
      },
    },
  );
  (indexCodebaseCommand.builder as unknown as (y: unknown) => unknown)(fakeYargs);
  return options;
}

describe("index-codebase --languages help text", () => {
  it("describes --force --languages as an in-place scoped re-chunk, not a whole-run restriction", () => {
    const text = declaredOptions().get("languages")?.describe ?? "";

    expect(text).toMatch(/scoped force/i);
    expect(text).toMatch(/in place/i);
    expect(text).not.toMatch(/whole run/i);
  });
});
