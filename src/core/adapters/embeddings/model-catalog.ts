// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * The embedding models the installer offers for llama-server, each pinned to a
 * Hugging Face GGUF by revision, sha256 and byte size. `id` is the Hugging Face
 * model id — the value written to EMBEDDING_MODEL and the key the
 * model-dimensions registry knows. Pins come from the Hugging Face API
 * (`/api/models/<repo>/revision/main?blobs=true`), never typed from a card.
 */

import { downloadVerifiedFile, type NativeAssetDeps, type VerifiedFileSource } from "../native-assets/index.js";
import { EmbeddingModelNotPublishedError } from "./errors.js";

/** One GGUF file on Hugging Face, pinned so a re-upload under the same name cannot change what is fetched. */
export interface EmbeddingModelGgufPin {
  repo: string;
  file: string;
  /** Full 40-hex commit of the Hugging Face repo. */
  revision: string;
  /** Lowercase hex of the file's LFS sha256. */
  sha256: string;
  bytes: number;
}

export interface EmbeddingModelCatalogEntry {
  /** Hugging Face model id — the EMBEDDING_MODEL value. */
  id: string;
  /** `null` = no published GGUF yet; the model cannot be fetched. */
  gguf: EmbeddingModelGgufPin | null;
  dimensions: number;
  /** Tokens per llama-server slot. */
  window: number;
  /** Programming languages the model card lists, in tea-rags language names. */
  trainedLanguages: readonly string[];
}

export const EMBEDDING_MODEL_CATALOG: readonly EmbeddingModelCatalogEntry[] = [
  {
    id: "jinaai/jina-embeddings-v2-base-code",
    gguf: {
      repo: "ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF",
      file: "jina-embeddings-v2-base-code-q8_0.gguf",
      revision: "05e79e9a6c8b99491e92ebb28d753268f8601e3c",
      sha256: "3bd1722f09350209aa3ada93df55882666c58194bfbbbe81c30545d731cb4e7a",
      bytes: 172869280,
    },
    dimensions: 768,
    window: 8192,
    trainedLanguages: [
      "assembly",
      "batchfile",
      "c",
      "csharp",
      "cpp",
      "cmake",
      "css",
      "dockerfile",
      "fortran",
      "go",
      "haskell",
      "html",
      "java",
      "javascript",
      "julia",
      "lua",
      "makefile",
      "markdown",
      "php",
      "perl",
      "powershell",
      "python",
      "ruby",
      "rust",
      "sql",
      "scala",
      "shell",
      "typescript",
      "tex",
      "visualbasic",
    ],
  },
  {
    id: "nomic-ai/CodeRankEmbed",
    gguf: {
      repo: "brandtcormorant/CodeRankEmbed-Q8_0-GGUF",
      file: "coderankembed-q8_0.gguf",
      revision: "33bd774d16ed49b07e79e89c192751d11f47fec0",
      sha256: "666db8df27c88570cdc07adca28646260038b8ca65354911d57b936ebf56efaa",
      bytes: 146029792,
    },
    dimensions: 768,
    window: 2048,
    trainedLanguages: ["python", "java", "javascript", "go", "php", "ruby"],
  },
  {
    // No public GGUF: publishing the f16 conversion is a user action. Until it
    // lands here, model choice falls through to CodeRankEmbed.
    id: "brokkai/Muninn-small",
    gguf: null,
    dimensions: 384,
    window: 8192,
    trainedLanguages: [
      "c",
      "cpp",
      "csharp",
      "go",
      "java",
      "javascript",
      "typescript",
      "php",
      "python",
      "rust",
      "scala",
    ],
  },
];

export function catalogEntryFor(id: string): EmbeddingModelCatalogEntry | undefined {
  return EMBEDDING_MODEL_CATALOG.find((entry) => entry.id === id);
}

/** The pinned `resolve/<revision>` download of a GGUF, verified against its LFS sha256. */
export function huggingFaceGgufSource(gguf: EmbeddingModelGgufPin): VerifiedFileSource {
  return {
    url: `https://huggingface.co/${gguf.repo}/resolve/${gguf.revision}/${gguf.file}`,
    sha256: gguf.sha256,
    fileName: gguf.file,
  };
}

/**
 * Download a catalog model's GGUF into `destDir`, sha256-verified and published
 * atomically; returns the file path. An entry without a published GGUF throws
 * before any network call.
 */
export async function downloadEmbeddingModelGguf(
  entry: EmbeddingModelCatalogEntry,
  destDir: string,
  deps: NativeAssetDeps,
): Promise<string> {
  if (entry.gguf === null) throw new EmbeddingModelNotPublishedError(entry.id);
  return downloadVerifiedFile(huggingFaceGgufSource(entry.gguf), destDir, deps);
}
