/**
 * SPIKE (bd tea-rags-mcp-1v12o.1.5, E5.1a) — WHY the 79 namesake rows refuse.
 *
 * Walks one corpus, then for each probed short name reports, per CALLER file:
 * the candidate files, the caller's import binding, what `mapImportToFile`
 * says, what `resolveExportedName` / `resolveExportedModule` add, and what the
 * two production halves answer today (`pythonCallBindingType`'s bare-callee
 * gate, `resolveTypeFile`).
 *
 * Usage:
 *   npx tsx scripts/spikes/py-namesake-narrowing-probe.ts --corpus polar \
 *     --names get_client,Subscription,Organization
 */
import { PythonImportFileMapper } from "../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import {
  findPythonImportBinding,
  lookupPythonSymbolsByShortName,
  receiverModuleText,
  resolveTypeFile,
} from "../../src/core/domains/language/python/resolver/strategies/shared.js";
import { parseArgs, walkCorpus } from "../py-codegraph-jedi-oracle.js";

const read = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const names = (read("--names") ?? "get_client").split(",").map((s) => s.trim());
  const walk = await walkCorpus(options.corpusRoot, options.limit, true, { dispatch: false });
  const mapper = new PythonImportFileMapper();

  // One ctx per caller file — every site in a file shares its imports.
  const ctxByFile = new Map<string, (typeof walk.sites)[number]["ctx"]>();
  for (const site of walk.sites) if (!ctxByFile.has(site.relPath)) ctxByFile.set(site.relPath, site.ctx);

  const any = walk.sites[0]?.ctx;
  if (any === undefined) throw new Error("no sites");

  const siteFile = read("--sites");
  if (siteFile !== undefined) {
    const from = Number(read("--from") ?? 0);
    const to = Number(read("--to") ?? Number.MAX_SAFE_INTEGER);
    for (const site of walk.sites) {
      if (site.relPath !== siteFile) continue;
      const line = site.call.startLine;
      if (line < from || line > to) continue;
      const recv = site.call.receiver ?? "";
      const bindings = site.ctx.localBindings?.[recv];
      const typeName = Array.isArray(bindings) ? bindings[bindings.length - 1]?.type : undefined;
      const typeFile = typeName === undefined ? null : resolveTypeFile(typeName, site.ctx, mapper);
      console.log(
        `${site.relPath}:${line} ${recv || "-"}.${site.call.member} kind=${site.receiverKind} answeredBy=${site.answeredBy} bucket=${site.missBucket} chain=${JSON.stringify(site.chain)}` +
          ` | bindings=${JSON.stringify(bindings)} typeFile=${typeFile}` +
          ` memberDefs=${JSON.stringify(lookupPythonSymbolsByShortName(site.ctx, site.call.member).map((d) => `${d.relPath}#${d.symbolId}`))}`,
      );
    }
    return;
  }

  for (const name of names) {
    const defs = lookupPythonSymbolsByShortName(any, name);
    const files = [...new Set(defs.map((d) => d.relPath))];
    console.log(`\n=== ${name} — ${defs.length} defs in ${files.length} files`);
    for (const f of files) console.log(`    decl ${f}`);
    console.log(`    structuredReturnTypes[${name}] = ${JSON.stringify(any.structuredReturnTypes?.[name])}`);

    let callers = 0;
    const prefix = read("--caller-prefix") ?? "";
    const onlyFailing = process.argv.includes("--only-failing");
    for (const [relPath, ctx] of ctxByFile) {
      if (!relPath.startsWith(prefix)) continue;
      const binding = findPythonImportBinding(ctx.imports, name);
      if (binding === null) continue;
      if (onlyFailing && resolveTypeFile(name, ctx, mapper) !== null) continue;
      if (callers++ >= Number(read("--max-callers") ?? 4)) break;
      const moduleText = receiverModuleText(binding);
      const direct = mapper.mapImportToFile(binding.imp.importText, relPath, ctx);
      const viaName =
        direct.kind === "project" ? mapper.resolveExportedName(direct.relPath, binding.importedName, ctx) : null;
      const viaModule =
        direct.kind === "project" ? mapper.resolveExportedModule(direct.relPath, binding.importedName, ctx) : null;
      const typeFile = resolveTypeFile(name, ctx, mapper);
      console.log(
        [
          `  caller ${relPath}`,
          `    importText=${JSON.stringify(binding.imp.importText)} importedName=${binding.importedName} moduleText=${moduleText}`,
          `    mapImportToFile -> ${JSON.stringify(direct)}`,
          `    resolveExportedName -> ${viaName}`,
          `    resolveExportedModule -> ${viaModule}`,
          `    resolveTypeFile -> ${typeFile}`,
          `    narrows to candidate? ${files.includes(viaName ?? (direct.kind === "project" ? direct.relPath : ""))}`,
        ].join("\n"),
      );
    }
    if (callers === 0) console.log("  (no caller file imports this name)");
  }
}

void main();
