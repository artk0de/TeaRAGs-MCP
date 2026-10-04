import { describe, expect, it } from "vitest";

import {
  DOCUMENT_METADATA_SCHEMA_KEY,
  DocumentMetadataSchemaCompiler,
  readDocumentMetadataSchema,
} from "../../../src/core/api/internal/ops/document-metadata-schema.js";
import {
  DocumentMetadataSchemaViolationError,
  InvalidDocumentMetadataSchemaError,
} from "../../../src/core/api/public/errors.js";

const bulletSchema = {
  type: "object",
  properties: {
    domain: { type: "string" },
    type: { enum: ["failure_mode", "decision", "anti_pattern", "migration", "domain_map"] },
    helpful: { type: "number", default: 0 },
    harmful: { type: "number", default: 0 },
    resolved_symbols: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["domain", "type"],
  additionalProperties: false,
};

describe("DocumentMetadataSchemaCompiler", () => {
  describe("compile", () => {
    it("accepts a JSON Schema whose top level describes an object", () => {
      const compiler = new DocumentMetadataSchemaCompiler();
      expect(() => compiler.compile(bulletSchema)).not.toThrow();
    });

    it("returns the same validator for a schema it has already compiled", () => {
      const compiler = new DocumentMetadataSchemaCompiler();
      const first = compiler.compile(bulletSchema);
      const second = compiler.compile(structuredClone(bulletSchema));
      expect(second).toBe(first);
    });

    it("rejects a schema whose top level is not an object type — it validates each metadata object", () => {
      const compiler = new DocumentMetadataSchemaCompiler();
      expect(() => compiler.compile({ type: "string" })).toThrow(InvalidDocumentMetadataSchemaError);
      expect(() => compiler.compile({ properties: { a: { type: "string" } } })).toThrow(
        InvalidDocumentMetadataSchemaError,
      );
    });

    it("rejects a schema Zod cannot compile, keeping the compiler's reason in the message", () => {
      const compiler = new DocumentMetadataSchemaCompiler();
      let caught: unknown;
      try {
        compiler.compile({ type: "object", properties: { a: { type: "strin" } } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidDocumentMetadataSchemaError);
      expect((caught as Error).message).toContain("strin");
      expect((caught as InvalidDocumentMetadataSchemaError).code).toBe("INPUT_INVALID_DOCUMENT_METADATA_SCHEMA");
    });
  });

  describe("DocumentMetadataValidator#parseBatch", () => {
    const validator = new DocumentMetadataSchemaCompiler().compile(bulletSchema);

    it("returns each document's metadata with schema defaults filled in", () => {
      const result = validator.parseBatch("memory", [
        { id: "b1", metadata: { domain: "crm/contacts", type: "decision" } },
        { id: "b2", metadata: { domain: "communication/sms", type: "failure_mode", helpful: 3 } },
      ]);

      expect(result).toEqual([
        { domain: "crm/contacts", type: "decision", helpful: 0, harmful: 0, resolved_symbols: [] },
        { domain: "communication/sms", type: "failure_mode", helpful: 3, harmful: 0, resolved_symbols: [] },
      ]);
    });

    it("validates absent metadata as an empty object, so required fields still bind", () => {
      expect(() => validator.parseBatch("memory", [{ id: "b1" }])).toThrow(DocumentMetadataSchemaViolationError);
    });

    it("rejects the whole batch when any document violates, reporting every violation", () => {
      let caught: unknown;
      try {
        validator.parseBatch("memory", [
          { id: "ok", metadata: { domain: "crm", type: "decision" } },
          { id: "bad-type", metadata: { domain: "crm", type: "decision", helpful: "a lot" } },
          { id: 7, metadata: { domain: "crm", type: "rumour" } },
        ]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DocumentMetadataSchemaViolationError);
      const error = caught as DocumentMetadataSchemaViolationError;
      expect(error.code).toBe("INPUT_DOCUMENT_METADATA_SCHEMA_VIOLATION");
      expect(error.violations).toEqual([
        expect.objectContaining({ documentIndex: 1, documentId: "bad-type", field: "helpful", received: "a lot" }),
        expect.objectContaining({ documentIndex: 2, documentId: 7, field: "type", received: "rumour" }),
      ]);
      // Field, expected type and the received value all reach the message.
      expect(error.message).toContain('"memory"');
      expect(error.message).toContain("helpful");
      expect(error.message).toContain("expected number");
      expect(error.message).toContain('"a lot"');
      expect(error.message).toContain("rumour");
    });

    it("names the unknown keys when the schema forbids additional properties", () => {
      let caught: unknown;
      try {
        validator.parseBatch("memory", [{ id: "x", metadata: { domain: "crm", type: "decision", extra: 1 } }]);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toContain("extra");
    });

    it("caps the message at the first ten violations and counts the rest", () => {
      const documents = Array.from({ length: 12 }, (_, i) => ({ id: i, metadata: { domain: 1, type: "decision" } }));
      let caught: unknown;
      try {
        validator.parseBatch("memory", documents);
      } catch (error) {
        caught = error;
      }
      const error = caught as DocumentMetadataSchemaViolationError;
      expect(error.violations).toHaveLength(12);
      expect(error.message).toContain("and 2 more");
    });
  });
});

describe("readDocumentMetadataSchema", () => {
  it("reads the schema stored under the collection metadata key", () => {
    expect(readDocumentMetadataSchema({ [DOCUMENT_METADATA_SCHEMA_KEY]: bulletSchema })).toEqual(bulletSchema);
  });

  it("is undefined for a collection created without a schema", () => {
    expect(readDocumentMetadataSchema(undefined)).toBeUndefined();
    expect(readDocumentMetadataSchema({})).toBeUndefined();
    expect(readDocumentMetadataSchema({ [DOCUMENT_METADATA_SCHEMA_KEY]: "not an object" })).toBeUndefined();
  });
});
