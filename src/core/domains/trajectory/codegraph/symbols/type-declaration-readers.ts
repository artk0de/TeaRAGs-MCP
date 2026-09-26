/**
 * The languages whose resolver READS `FileExtraction.typeDeclarations` (bd
 * tea-rags-mcp-vi0wx, spec §1b) — the resolution scope of the channel.
 *
 * Every walker may publish type declarations for the naming lexicon's
 * `cg_type_declarations`; only these languages' facts may enter the run-global
 * `typeDeclarations` map and the persisted pass-1 slice. The fact is the
 * language capability `codegraph.resolverReadsTypeDeclarations`, read through
 * the injected factory because `trajectory` may not import the `language`
 * domain. Collected ONCE per provider, like the other language-fact collectors.
 */

import type { LanguageFactoryDescriptor } from "../../../../contracts/types/language.js";

export function collectTypeDeclarationReaders(languageFactory: LanguageFactoryDescriptor | undefined): Set<string> {
  const readers = new Set<string>();
  const capabilities = languageFactory?.capabilities?.();
  if (capabilities === undefined) return readers;
  for (const [language, capability] of capabilities) {
    if (capability.codegraph.resolverReadsTypeDeclarations === true) readers.add(language);
  }
  return readers;
}
