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

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";

/** Files read at once — a bound on concurrent scrolls, not a batch the answer depends on. */
const IMPORT_SPECIFIER_READ_CONCURRENCY = 8;

/**
 * `relPaths`' declared specifiers, keyed by path. A file the index does not
 * hold, or one that declares no import, is absent from the map.
 */
export async function readPayloadImportSpecifiers(
  qdrant: Pick<QdrantManager, "scrollFiltered">,
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
