/**
 * Swift module-level values (bd tea-rags-mcp-y99pg.30) — a file-scope `let` /
 * `var`, visible to every file of its module. Alamofire's
 * `public let AF = Session.default` is called as `AF.request(…)` from files
 * that never declare it, and no per-chunk channel can carry that: a chunk's
 * `localBindings` / `callResultBindings` reach only the calls of that chunk.
 *
 * Published under the module-scope key `<relPath>::`
 * (`swiftModuleScopeKey`), on the two run-global field channels the run state
 * already unions:
 *
 *   - `classFieldTypesByClassKey` when the declaration spells the type — an
 *     annotation or a CapWords construction, the rule a stored property
 *     follows. That channel is hydrated, so the fact survives an incremental
 *     run that does not re-walk the declaring file;
 *   - `classFieldCallResults` otherwise, as the right-hand side's value-chain
 *     SPELLING (`Session.default`) for the resolver to fold with the whole run
 *     in scope. That channel is batch-only: a run that does not walk the
 *     declaring file types the value no more than an index without this pass
 *     did — an edge missing, never a wrong one.
 *
 * `private` / `fileprivate` values are not published: they never leave the
 * file, and a run-global name must not type a namesake in another one.
 */

import { createIdentifierRecord } from "../../../../../contracts/identifier-record.js";
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "../../../kernel/index.js";
import { swiftModuleScopeKey } from "../../type-field-address.js";
import { swiftModuleValueOf } from "../walker.js";
import { swiftVisibility } from "./declared-visibility.js";

export const swiftModuleValuesFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    const typed: Record<string, string> = createIdentifierRecord();
    const spelled: Record<string, string> = createIdentifierRecord();
    // The source file's own children ARE file scope: a type body, a function
    // body and a closure all nest their declarations below them.
    for (const node of root.children) {
      if (swiftVisibility(node) === "private") continue;
      const value = swiftModuleValueOf(node);
      if (value === null) continue;
      if (value.type !== undefined) typed[value.name] = value.type;
      else if (value.spelling !== undefined) spelled[value.name] = value.spelling;
    }
    const key = swiftModuleScopeKey(ctx.relPath);
    const out: Partial<FileExtraction> = {};
    if (Object.keys(typed).length > 0) out.classFieldTypesByClassKey = { [key]: typed };
    if (Object.keys(spelled).length > 0) out.classFieldCallResults = { [key]: spelled };
    return out;
  },
};
