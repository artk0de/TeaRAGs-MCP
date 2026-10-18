import { z } from "zod";

import type { LanguageCapability, LanguageVersionPolicy } from "../../../contracts/types/language.js";
import { resolveLanguageCodeVersions } from "./versions.js";

const policyEvidence = {
  evidence: z.string().trim().min(1),
  limitations: z.string().trim().min(1),
};

/** Runtime guard for generated views; required TS fields alone cannot reject untyped input. */
export const languageVersionPolicySchema: z.ZodType<LanguageVersionPolicy> = z.discriminatedUnion("policy", [
  z.strictObject({ ...policyEvidence, policy: z.literal("fixture-validated"), target: z.string().trim().min(1) }),
  z.strictObject({ ...policyEvidence, policy: z.literal("grammar-bounded") }),
  z.strictObject({ ...policyEvidence, policy: z.literal("unversioned") }),
]);

/** Shared generated view: source-language claim, parser semver and our revision counters stay separate. */
export function renderLanguageVersionPolicies(capabilities: ReadonlyMap<string, LanguageCapability>): string {
  const codeVersions = resolveLanguageCodeVersions(capabilities);
  const rows = [...capabilities.values()].map((capability) => {
    const versionPolicy = languageVersionPolicySchema.parse(capability.languageVersion);
    const { grammarPackage } = capability.ast;
    const grammarVersion = codeVersions.get(capability.language)?.grammar;
    const grammar =
      grammarPackage === undefined
        ? "N/A (no tree-sitter grammar)"
        : `${grammarPackage}@${grammarVersion ?? "unavailable"}`;
    const target = versionPolicy.policy === "fixture-validated" ? versionPolicy.target : versionPolicy.policy;
    const { chunking, walker, codegraphSchema } = capability.versions;
    const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
    return `| ${capability.language} | ${cell(target)} | ${grammar} | ${chunking} / ${walker} / ${codegraphSchema} | ${cell(versionPolicy.limitations)} · ${versionPolicy.evidence} |`;
  });
  return `## Language / toolchain versions

Descriptor policy is authoritative. Fixture-validated means syntax examples, not compiler conformance.
Grammar-bounded means installed parser plus project fixtures; no certified release range.
Unversioned means dialect-based documents or syntax-blind fallback. Internal revisions only route index rebuilds.

| Language | Language / toolchain policy | Grammar package version | Internal revisions (chunking / walker / codegraphSchema) | Evidence and limits |
| --- | --- | --- | --- | --- |
${rows.join("\n")}`;
}
