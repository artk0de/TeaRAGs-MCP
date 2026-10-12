/**
 * The module specifiers a file declares, read back from the index payload
 * (bd tea-rags-mcp-rbnkp).
 *
 * `payload.imports` is the one place a file's import of a NON-code file
 * survives: the codegraph drops an import of a stylesheet, a JSON module or an
 * image at resolve time (bd tea-rags-mcp-unt4v), because no file node backs it.
 * Silent coupling asks this for the walked endpoints of its one-walked
 * violations, so a `.tsx` and the `.module.css` it imports stop reading as
 * silent.
 *
 * Every chunk of a file carries the same `imports` (`SourceFileIngestor`
 * stamps the file's list onto each), so ONE point per file answers, matched
 * exactly on `relativePath` through its index-served pair.
 */

import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type { QdrantPointReader } from "../../../adapters/qdrant/ports.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";
import type { IndexedFileImports } from "../../../domains/trajectory/codegraph/symbols/index.js";
import { TEST_EXCLUSION_FILTER_CONDITIONS } from "../../../domains/trajectory/static/index.js";

/** Files read at once — a bound on concurrent scrolls, not a batch the answer depends on. */
const IMPORT_SPECIFIER_READ_CONCURRENCY = 8;

/**
 * `relPaths`' declared specifiers, keyed by path. A file the index does not
 * hold, or one that declares no import, is absent from the map.
 */
export async function readPayloadImportSpecifiers(
  qdrant: Pick<QdrantPointReader, "scrollFiltered">,
  collectionName: string,
  relPaths: readonly RelPath[],
): Promise<Map<RelPath, string[]>> {
  const specifiers = new Map<RelPath, string[]>();
  for (let start = 0; start < relPaths.length; start += IMPORT_SPECIFIER_READ_CONCURRENCY) {
    const window = relPaths.slice(start, start + IMPORT_SPECIFIER_READ_CONCURRENCY);
    const points = await Promise.all(
      window.map(async (relPath) =>
        qdrant.scrollFiltered(collectionName, { must: exactMatchOnTextIndexed("relativePath", relPath) }, 1, 1, [
          "imports",
        ]),
      ),
    );
    window.forEach((relPath, i) => {
      const imports = points[i][0]?.payload.imports;
      if (Array.isArray(imports) && imports.length > 0) {
        specifiers.set(
          relPath,
          imports.filter((s): s is string => typeof s === "string"),
        );
      }
    });
  }
  return specifiers;
}

/**
 * Every indexed file's declared specifiers and whether it is a test, keyed by
 * path (bd tea-rags-mcp-89k7k.35.3). The architecture report derives test
 * support from it: the codegraph walks no test, generated or policy-excluded
 * file, so their imports survive only here. "Is a test" is the query path's
 * one definition (`TEST_EXCLUSION_FILTER_CONDITIONS`): a point carrying any of
 * its conditions. One payload-narrowed pass, one chunk per file — the way
 * `readPayloadFileMaintenanceSignals` reads every file.
 */
export async function readPayloadIndexedFileImports(
  qdrant: Pick<QdrantPointReader, "scrollPayloadPages">,
  collectionName: string,
): Promise<Map<RelPath, IndexedFileImports>> {
  const files = new Map<RelPath, IndexedFileImports>();
  for await (const page of qdrant.scrollPayloadPages(collectionName, indexedFileImportPayloadKeys())) {
    for (const { payload } of page) {
      const { relativePath, imports } = payload;
      if (typeof relativePath !== "string" || files.has(relativePath)) continue;
      if (!Array.isArray(imports) || imports.length === 0) continue;
      files.set(relativePath, {
        isTest: TEST_EXCLUSION_FILTER_CONDITIONS.some(
          (condition) => readPayloadPath(payload, condition.key) === condition.match.value,
        ),
        specifiers: imports.filter((s): s is string => typeof s === "string"),
      });
    }
  }
  return files;
}

/** Read per call, never at module load — the conditions belong to another domain's barrel. */
function indexedFileImportPayloadKeys(): string[] {
  return ["relativePath", "imports", ...TEST_EXCLUSION_FILTER_CONDITIONS.map((condition) => condition.key)];
}

/** A dotted payload path read off the nested payload object. */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  let value: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
