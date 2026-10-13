/**
 * Binds {@link LanguagePresencePorts} to a real collection and working tree.
 * Kept apart from the guard so the guard's decision stays free of I/O.
 */

import { extname } from "node:path";

import {
  extensionsForLanguages,
  LANGUAGE_MAP,
} from "../../../domains/ingest/pipeline/chunker/language-config/index.js";
import { FileScanner } from "../../../domains/ingest/pipeline/scanner.js";
import type { LanguagePresencePorts } from "./language-presence-guard.js";

export interface LanguagePresenceBindings {
  countPoints: (collectionName: string, filter?: Record<string, unknown>) => Promise<number>;
  collectionName: string;
  absolutePath: string;
  ignorePatterns: string[];
  customIgnorePatterns?: string[];
}

export function bindLanguagePresencePorts(bindings: LanguagePresenceBindings): LanguagePresencePorts {
  return {
    countIndexed: async (language) =>
      bindings.countPoints(bindings.collectionName, { must: [{ key: "language", match: { value: language } }] }),
    languagesInTree: async (languages) => {
      const scanner = new FileScanner({
        supportedExtensions: extensionsForLanguages(languages),
        ignorePatterns: bindings.ignorePatterns,
        customIgnorePatterns: bindings.customIgnorePatterns,
      });
      await scanner.loadIgnorePatterns(bindings.absolutePath);
      const files = await scanner.scanDirectory(bindings.absolutePath);
      const present = new Set<string>();
      for (const file of files) {
        const language = LANGUAGE_MAP[extname(file).toLowerCase()];
        if (language) present.add(language);
      }
      return [...present];
    },
  };
}
