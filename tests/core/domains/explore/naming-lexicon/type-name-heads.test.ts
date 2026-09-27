import { describe, expect, it } from "vitest";

import { typeNameHeadCarriers } from "../../../../../src/core/domains/explore/naming-lexicon/type-name-heads.js";
import type { TypeNameRow } from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";

function declared(shortName: string, relPath: string, symbolKind: TypeNameRow["symbolKind"] = "module"): TypeNameRow {
  return { symbolId: shortName, relPath, shortName, symbolKind, ancestors: [] };
}

// bd tea-rags-mcp-i569j, live on taxdome: app/lib holds 151 `*_helper.rb` declarations and one
// `*_concern.rb`, yet `types: ["Helper", "Concern"]` answered two local variables.
const ROWS = [
  declared("NameHelper", "app/lib/name_helper.rb", "class"),
  declared("DateTimeHelper", "app/lib/date_time_helper.rb", "class"),
  declared("ErrorsHelper", "app/lib/workflow/errors_helper.rb"),
  declared("RefusalsConcern", "app/lib/tax/refusals_concern.rb"),
  // A namespace module wraps its file's subject: it locates, it declares no `Helper`.
  declared("Helpers", "app/lib/workflow/steps.rb"),
  // A helper as a name's QUALIFIER is not the name's head.
  declared("HelperRegistry", "app/lib/helper_registry.rb", "class"),
];

describe("typeNameHeadCarriers", () => {
  it("counts the declarations whose name ENDS in the word, per kind, with examples", () => {
    expect(typeNameHeadCarriers(ROWS, ["Helper", "Concern"])).toEqual([
      {
        head: "Helper",
        n: 3,
        files: 3,
        kinds: { class: 2, module: 1 },
        examples: ["NameHelper", "DateTimeHelper", "ErrorsHelper"],
      },
      { head: "Concern", n: 1, files: 1, kinds: { module: 1 }, examples: ["RefusalsConcern"] },
    ]);
  });

  it("matches the word in any number and casing, and answers a word nothing carries with zero", () => {
    expect(typeNameHeadCarriers(ROWS, ["helpers", "Presenter"])).toEqual([
      expect.objectContaining({ head: "helpers", n: 3 }),
      { head: "Presenter", n: 0, files: 0, kinds: {}, examples: [] },
    ]);
  });

  it("reads only single-word asks: a multi-word type is a type, not a head", () => {
    expect(typeNameHeadCarriers(ROWS, ["ErrorsHelper", "TaxAutomationDocument"])).toEqual([]);
  });
});
