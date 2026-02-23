/**
 * Maps file extensions to language identifiers.
 */

import { extname } from "node:path";

import { LANGUAGE_MAP } from "./chunker/config.js";

export function detectLanguage(filePath: string): string {
  const ext = extname(filePath);
  return LANGUAGE_MAP[ext] || "unknown";
}
