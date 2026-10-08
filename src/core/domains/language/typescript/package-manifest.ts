import type { DeclaredDependencyScopes, TestDependencyManifestSource } from "../../../contracts/types/language.js";

/** `package.json` sections whose packages the code may import at run time. */
const RUNTIME_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

const NO_SCOPES: DeclaredDependencyScopes = { developmentOnly: [], runtime: [] };

/**
 * One `package.json`'s packages split by section (bd tea-rags-mcp-89k7k.35.3):
 * `devDependencies` are development-only, `dependencies`,
 * `peerDependencies` and `optionalDependencies` runtime. Malformed JSON, or a
 * section that is not an object, declares nothing.
 */
export function packageJsonDependencyScopes(content: string): DeclaredDependencyScopes {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return NO_SCOPES;
  }
  if (!isRecord(manifest)) return NO_SCOPES;
  return {
    developmentOnly: sectionNames(manifest.devDependencies),
    runtime: RUNTIME_SECTIONS.flatMap((section) => sectionNames(manifest[section])),
  };
}

function sectionNames(section: unknown): string[] {
  return isRecord(section) ? Object.keys(section) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The ECMAScript family's development-dependency manifest: every `package.json`.
 * TypeScript and JavaScript share this one object, so a walk asking both reads
 * each file once.
 */
export const PACKAGE_JSON_TEST_DEPENDENCY_MANIFEST: TestDependencyManifestSource = {
  matchesManifestFile: (fileName) => fileName === "package.json",
  parseDependencyScopes: (_fileName, content) => packageJsonDependencyScopes(content),
};
