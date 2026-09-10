/**
 * Where an oracle target lives — `classify_origin` ported out of
 * `jedi_oracle.py:64` so a SECOND engine answers the same question the same way
 * (bd tea-rags-mcp-w205u, E4.0.2).
 *
 * The port exists because the origin column is what the two engines are compared
 * ON. An engine that classified its own bundled typeshed as `outsideRepo` while
 * jedi called its bundled typeshed `typeshedStub` would disagree with jedi on
 * every stdlib answer without either being wrong about anything.
 */
import { basename, relative, sep } from "node:path";

import type { PyTargetOrigin } from "./py-oracle-core.js";

/**
 * Bundled-stub directories, one family per engine.
 *
 * The first two are jedi's (`JEDI_STUB_MARKERS`). The rest are what the spike
 * measured the LSP candidates answering out of: pyright ships
 * `dist/typeshed-fallback/`, ty unpacks `~/.cache/ty/vendored/typeshed/<sha>/`.
 * Without them a stdlib answer reads `outsideRepo` — the cache is outside the
 * corpus and under no `lib/python3.x/` — and the origin column stops being
 * comparable across engines, which is the whole point of the port.
 */
export const PY_STUB_MARKERS = [
  "/jedi/third_party/typeshed/",
  "/jedi/third_party/django-stubs/",
  "/typeshed-fallback/",
  "/vendored/typeshed/",
] as const;

/** `STDLIB_DIR_RE` verbatim — site-packages lives under the same prefix. */
const STDLIB_DIR_RE = /\/lib\/python3\.\d+\/(?!site-packages\/)/;

/** The two origins that put a target INSIDE the scored tree (`IN_PROJECT_ORIGINS`). */
export const PY_IN_PROJECT_ORIGINS: ReadonlySet<PyTargetOrigin> = new Set(["project", "generatedInRepo"]);

/**
 * Port of `jedi_oracle.py:classify_origin`. The ORDER is load-bearing and is
 * not the obvious one — that docstring records the two measured
 * misclassifications it fixed, and both re-open on any reordering:
 *
 *   - three PATH tests run BEFORE corpus containment, because ugnest keeps its
 *     virtualenv inside its own checkout and a root-prefix-first order called
 *     Django's own source "project" in 26 of 30 sampled targets;
 *   - the stdlib NAME test runs LAST and only for a path the corpus does not
 *     contain, because a project may own a module called `string` or `types` —
 *     running it ahead of containment scored the chain's CORRECT answer a
 *     phantom on 432 netbox rows and 46 polar rows (7dsyq).
 *
 * `stdlibNames` is the interpreter's own `sys.stdlib_module_names`, never a
 * literal: `PYTHON_STDLIB_MODULES` is generated from the corpora's interpreters
 * by `scripts/py-oracle/gen-stdlib-modules.py`.
 */
export function classifyOrigin(
  absTargetPath: string | null,
  corpusRoot: string,
  stdlibNames: ReadonlySet<string>,
): PyTargetOrigin {
  if (absTargetPath === null) return "builtin";
  const text = absTargetPath.split(sep).join("/");
  if (PY_STUB_MARKERS.some((marker) => text.includes(marker))) return "typeshedStub";
  if (text.includes("/site-packages/") || text.includes("/dist-packages/")) return "sitePackages";
  if (STDLIB_DIR_RE.test(text)) return "stdlib";
  const rel = relative(corpusRoot, absTargetPath);
  if (rel === "" || rel.startsWith("..")) {
    const stem = basename(text).replace(/\.pyi?$/, "");
    return stdlibNames.has(stem) ? "stdlib" : "outsideRepo";
  }
  return rel.split(sep).includes("migrations") ? "generatedInRepo" : "project";
}
