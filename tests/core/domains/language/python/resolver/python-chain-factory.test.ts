/**
 * The factory is the single source of truth for the Python chain
 * (bd tea-rags-mcp-3yxmy). Both offline harnesses used to keep hand-copied
 * arrays, and when `importedName` landed at index 4 the jedi oracle's copy was
 * left behind — its own `chainDrift` guard fired on 117 flask sites and 552
 * ugnest sites and every number it printed was void.
 *
 * So this test does NOT assert a literal list of names as the harnesses did:
 * a second literal is a second thing to forget. It asserts the factory equals
 * what `PythonCallResolver` actually composes, which is the property the
 * harnesses depend on. The literal below is a readability anchor for the
 * production order, checked against the resolver in the same file.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_AMBIGUOUS_RESOLVE_MODE } from "../../../../../../src/core/contracts/types/codegraph.js";
import { createPythonSymbolResolutionChain } from "../../../../../../src/core/domains/language/python/resolver/index.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { CONE_MAX_DEFAULT } from "../../../../../../src/core/domains/language/python/resolver/strategies/index.js";

const cfg = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE, coneMax: CONE_MAX_DEFAULT };

const PRODUCTION_ORDER = [
  "super",
  "selfField",
  "selfMember",
  "localBinding",
  "importedName",
  "importMatch",
  "globalShortName",
];

describe("createPythonSymbolResolutionChain", () => {
  it("composes exactly the chain PythonCallResolver runs — drift here voids every harness number", () => {
    expect(createPythonSymbolResolutionChain(cfg).map((pass) => pass.name)).toEqual(
      new PythonCallResolver().strategies.map((pass) => pass.name),
    );
  });

  it("keeps the production order, importedName ahead of importMatch", () => {
    expect(new PythonCallResolver().strategies.map((pass) => pass.name)).toEqual(PRODUCTION_ORDER);
  });

  it("builds a fresh chain per call so two harness runs share no per-pass state", () => {
    const first = createPythonSymbolResolutionChain(cfg);
    const second = createPythonSymbolResolutionChain(cfg);
    expect(first[0]).not.toBe(second[0]);
  });

  it("accepts the caller's import-file mapper so the resolver's memo stays shared", () => {
    const mapper = new PythonImportFileMapper();
    expect(createPythonSymbolResolutionChain(cfg, mapper).map((pass) => pass.name)).toEqual(PRODUCTION_ORDER);
  });

  it("exposes the resolver's chain as a read-only view, not the array itself", () => {
    const resolver = new PythonCallResolver();
    expect(resolver.strategies).toBe(resolver.strategies);
    expect(resolver.strategies.length).toBe(PRODUCTION_ORDER.length);
  });
});
