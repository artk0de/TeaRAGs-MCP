/**
 * bd tea-rags-mcp-83cl7 — the Ruby CORE member vocabulary consulted by the
 * core-homonym denominator classifier.
 *
 * Invariants pinned here:
 *  1. ONE vocabulary. `RUBY_CORE_MEMBERS` is the UNION of the existing
 *     `runtimeBuiltins` facet (`RUBY_KERNEL_BUILTINS`) and the additive
 *     Enumerable/collection extension — no name is written twice.
 *  2. The measured taxdome homonym offenders (`each`, `to_s`, `first`, `join`,
 *     `merge`, `to_h`) are members.
 *  3. Names with a strong PROJECT-def idiom (service-object `call`, Rails/AS
 *     `present?`/`blank?`/`where`/`pluck`) are NOT members — classifying them
 *     would hide a real recall hole (reverse precision).
 *  4. The bare-call external vocabulary is untouched: extending the core-member
 *     set must NOT make an Enumerable name an external BARE call (that would
 *     move the ykj7 `externalSkipped` counter).
 */
import { describe, expect, it } from "vitest";

import {
  RUBY_CORE_MEMBERS,
  RUBY_ENUMERABLE_MEMBERS,
} from "../../../../../../src/core/domains/language/ruby/dsl/core-members.js";
import {
  isCoreAmbiguousMember,
  isExternalBareCall,
  isExternalQualifiedMember,
} from "../../../../../../src/core/domains/language/ruby/dsl/index.js";
import { RUBY_KERNEL_BUILTINS } from "../../../../../../src/core/domains/language/ruby/dsl/kernel-builtins.js";

describe("Ruby core-member vocabulary (83cl7)", () => {
  it("is the union of the runtime-builtins facet and the Enumerable extension", () => {
    for (const name of RUBY_KERNEL_BUILTINS) expect(RUBY_CORE_MEMBERS.has(name)).toBe(true);
    for (const name of RUBY_ENUMERABLE_MEMBERS) expect(RUBY_CORE_MEMBERS.has(name)).toBe(true);
    expect(RUBY_CORE_MEMBERS.size).toBe(RUBY_KERNEL_BUILTINS.size + RUBY_ENUMERABLE_MEMBERS.size);
  });

  it("writes no name twice across the two sets", () => {
    const dupes = [...RUBY_ENUMERABLE_MEMBERS].filter((m) => RUBY_KERNEL_BUILTINS.has(m));
    expect(dupes).toEqual([]);
  });

  it("never re-owns a name already classified EXTERNAL on the qualified-member axis", () => {
    // `isExternalQualifiedMember` (ACTIVE_RECORD_INSTANCE_BUILTINS) fires one step
    // earlier in the classifier chain — a name in both sets would have two
    // authorities for the same decision.
    const overlap = [...RUBY_ENUMERABLE_MEMBERS].filter((m) => isExternalQualifiedMember(m));
    expect(overlap).toEqual([]);
  });

  it("covers the measured taxdome homonym offenders", () => {
    for (const member of ["each", "to_s", "first", "join", "merge", "to_h", "merge!", "count", "push", "sort_by"]) {
      expect(isCoreAmbiguousMember(member)).toBe(true);
    }
  });

  it("excludes names with a strong project-def idiom", () => {
    for (const member of ["call", "new", "present?", "blank?", "where", "pluck", "as_json", "perform", "execute"]) {
      expect(isCoreAmbiguousMember(member)).toBe(false);
    }
  });

  it("leaves the bare-call external vocabulary untouched", () => {
    // `each`/`map`/`first` are core MEMBERS but not Kernel bare-call names — a
    // no-receiver `each` must stay OUT of the ykj7 externalSkipped bucket.
    for (const member of ["each", "map", "first", "join", "merge", "to_h"]) {
      expect(isExternalBareCall(member)).toBe(false);
    }
    // The pre-existing Kernel names stay external bare calls (no regression).
    expect(isExternalBareCall("puts")).toBe(true);
    expect(isExternalBareCall("to_s")).toBe(true);
  });
});
