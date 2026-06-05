// Copyright (c) 2025 Martin Halder <halderm@arkadia-labs.io>
// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Base interface for code chunkers
 */

import type { CodeChunk } from "../../../../types.js";

export interface CodeChunker {
  /**
   * Split code into semantic chunks
   */
  chunk: (code: string, filePath: string, language: string) => Promise<CodeChunk[]>;

  /**
   * Check if language is supported by this chunker
   */
  supportsLanguage: (language: string) => boolean;

  /**
   * Get chunking strategy name
   */
  getStrategyName: () => string;
}
