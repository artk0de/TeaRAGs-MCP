/**
 * Typed collections — the document metadata schema a collection may carry
 * (bd tea-rags-mcp-e0tf).
 *
 * `create_collection` accepts an optional JSON Schema; it is compiled to Zod
 * there (an uncompilable schema never creates a collection) and stored in the
 * Qdrant collection's own `metadata` under `DOCUMENT_METADATA_SCHEMA_KEY`.
 * `add_documents` reads it back with the collection info it already fetches,
 * and validates the whole batch before anything is embedded.
 *
 * The compiled validator is cached by the schema's serialized form, not by
 * collection name: a collection dropped and recreated with another schema
 * under the same name then needs no invalidation — its new schema is simply a
 * different key.
 */

import { z } from "zod";

import {
  DocumentMetadataSchemaViolationError,
  InvalidDocumentMetadataSchemaError,
  type DocumentMetadataViolation,
} from "../../errors.js";
import type { AddDocumentsRequest, DocumentMetadataSchema } from "../../public/dto/index.js";

/** Key of the schema inside the Qdrant collection metadata. */
export const DOCUMENT_METADATA_SCHEMA_KEY = "documentMetadataSchema";

type DocumentForValidation = Pick<AddDocumentsRequest["documents"][number], "id" | "metadata">;

/** A compiled schema: validates one `add_documents` batch as a unit. */
export class DocumentMetadataValidator {
  constructor(private readonly schema: z.ZodType) {}

  /**
   * Parse every document's metadata (absent metadata = `{}`, so required
   * fields still bind). Returns the parsed metadata — schema defaults filled
   * in — in document order, or throws one error carrying every violation in
   * the batch.
   */
  parseBatch(collection: string, documents: DocumentForValidation[]): Record<string, unknown>[] {
    const parsed: Record<string, unknown>[] = [];
    const violations: DocumentMetadataViolation[] = [];

    documents.forEach((doc, documentIndex) => {
      const input = doc.metadata ?? {};
      const result = this.schema.safeParse(input);
      if (result.success) {
        parsed.push(result.data as Record<string, unknown>);
        return;
      }
      for (const issue of result.error.issues) {
        violations.push({
          documentIndex,
          documentId: doc.id,
          field: issue.path.map(String).join("."),
          expected: issue.message,
          received: valueAt(input, issue.path),
        });
      }
    });

    if (violations.length > 0) throw new DocumentMetadataSchemaViolationError(collection, violations);
    return parsed;
  }
}

/** Compiles document metadata schemas to validators, once per distinct schema. */
export class DocumentMetadataSchemaCompiler {
  private readonly cache = new Map<string, DocumentMetadataValidator>();

  compile(schema: DocumentMetadataSchema): DocumentMetadataValidator {
    const key = JSON.stringify(schema);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (schema.type !== "object") {
      throw new InvalidDocumentMetadataSchemaError(
        `top-level "type" must be "object" (got ${JSON.stringify(schema.type)}) — the schema validates each document's metadata object`,
      );
    }

    let compiled: z.ZodType;
    try {
      compiled = z.fromJSONSchema(schema);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new InvalidDocumentMetadataSchemaError(cause?.message ?? String(error), cause);
    }

    const validator = new DocumentMetadataValidator(compiled);
    this.cache.set(key, validator);
    return validator;
  }
}

/** The schema a collection was created with, or undefined for an untyped collection. */
export function readDocumentMetadataSchema(
  collectionMetadata: Record<string, unknown> | undefined,
): DocumentMetadataSchema | undefined {
  const schema = collectionMetadata?.[DOCUMENT_METADATA_SCHEMA_KEY];
  return isPlainObject(schema) ? schema : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}
