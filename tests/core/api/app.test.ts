/**
 * App interface type-level verification tests.
 *
 * These tests verify that:
 * 1. All types are correctly defined and compile
 * 2. Request/response types have the expected shape
 * 3. The App interface contract is structurally sound
 * 4. Re-exported domain types are accessible
 */

import { describe, expect, it } from "vitest";

import type {
  AddDocumentsRequest,
  App,
  ChangeStats,
  CollectionInfo,
  CollectionRef,
  CreateCollectionRequest,
  DeleteDocumentsRequest,
  HybridSearchRequest,
  IndexOptions,
  IndexStats,
  IndexStatus,
  PresetDescriptors,
  ProgressCallback,
  RankChunksRequest,
  SearchCodeRequest,
  SearchCodeResponse,
  SearchCodeResult,
  SearchResponse,
  SearchResult,
  SemanticSearchRequest,
  SignalDescriptor,
} from "../../../src/core/api/index.js";

// ---------------------------------------------------------------------------
// Helpers: compile-time type assertions
// ---------------------------------------------------------------------------

/** Compile-time assignability check: if this type resolves, A extends B. */
type AssertExtends<A extends B, B> = A;

// ---------------------------------------------------------------------------
// CollectionRef
// ---------------------------------------------------------------------------

describe("CollectionRef", () => {
  it("accepts collection only", () => {
    const ref: CollectionRef = { collection: "test" };
    expect(ref.collection).toBe("test");
    expect(ref.path).toBeUndefined();
  });

  it("accepts path only", () => {
    const ref: CollectionRef = { path: "/some/path" };
    expect(ref.path).toBe("/some/path");
    expect(ref.collection).toBeUndefined();
  });

  it("accepts both collection and path", () => {
    const ref: CollectionRef = { collection: "test", path: "/some/path" };
    expect(ref.collection).toBe("test");
    expect(ref.path).toBe("/some/path");
  });

  it("accepts empty object", () => {
    const ref: CollectionRef = {};
    expect(ref.collection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Search request types
// ---------------------------------------------------------------------------

describe("SemanticSearchRequest", () => {
  it("extends CollectionRef", () => {
    type _Check = AssertExtends<SemanticSearchRequest, CollectionRef>;
    expect(true).toBe(true);
  });

  it("requires query", () => {
    const req: SemanticSearchRequest = { query: "test" };
    expect(req.query).toBe("test");
  });

  it("accepts all optional fields", () => {
    const req: SemanticSearchRequest = {
      collection: "code_abc",
      path: "/project",
      query: "authentication logic",
      limit: 20,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
      pathPattern: "src/**/*.ts",
      rerank: "techDebt",
      metaOnly: true,
    };
    expect(req.limit).toBe(20);
    expect(req.metaOnly).toBe(true);
  });

  it("accepts custom rerank weights", () => {
    const req: SemanticSearchRequest = {
      query: "test",
      rerank: { custom: { similarity: 0.7, recency: 0.3 } },
    };
    expect(req.rerank).toEqual({ custom: { similarity: 0.7, recency: 0.3 } });
  });
});

describe("HybridSearchRequest", () => {
  it("extends CollectionRef", () => {
    type _Check = AssertExtends<HybridSearchRequest, CollectionRef>;
    expect(true).toBe(true);
  });

  it("requires query", () => {
    const req: HybridSearchRequest = { query: "TODO FIXME" };
    expect(req.query).toBe("TODO FIXME");
  });

  it("accepts all optional fields", () => {
    const req: HybridSearchRequest = {
      collection: "code_abc",
      query: "tech debt markers",
      limit: 10,
      filter: {},
      pathPattern: "**/*.ts",
      rerank: { custom: { churn: 0.5, age: 0.5 } },
      metaOnly: false,
    };
    expect(req.rerank).toEqual({ custom: { churn: 0.5, age: 0.5 } });
  });
});

describe("RankChunksRequest", () => {
  it("extends CollectionRef", () => {
    type _Check = AssertExtends<RankChunksRequest, CollectionRef>;
    expect(true).toBe(true);
  });

  it("requires rerank and level", () => {
    const req: RankChunksRequest = { rerank: "decomposition", level: "chunk" };
    expect(req.rerank).toBe("decomposition");
    expect(req.level).toBe("chunk");
  });

  it("accepts all optional fields", () => {
    const req: RankChunksRequest = {
      collection: "code_abc",
      rerank: { custom: { chunkSize: 1.0 } },
      level: "file",
      limit: 50,
      offset: 10,
      filter: {},
      pathPattern: "src/**",
      metaOnly: true,
    };
    expect(req.limit).toBe(50);
    expect(req.offset).toBe(10);
  });
});

describe("SearchCodeRequest", () => {
  it("requires path and query", () => {
    const req: SearchCodeRequest = { path: "/project", query: "auth" };
    expect(req.path).toBe("/project");
    expect(req.query).toBe("auth");
  });

  it("accepts all optional fields", () => {
    const req: SearchCodeRequest = {
      path: "/project",
      query: "authentication",
      limit: 15,
      fileTypes: [".ts", ".js"],
      pathPattern: "src/**",
      documentationOnly: false,
      author: "John",
      modifiedAfter: "2025-01-01",
      modifiedBefore: new Date("2025-12-31"),
      minAgeDays: 30,
      maxAgeDays: 365,
      minCommitCount: 5,
      taskId: "TD-123",
      rerank: "recent",
    };
    expect(req.author).toBe("John");
    expect(req.minAgeDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Search result types
// ---------------------------------------------------------------------------

describe("SearchResult", () => {
  it("has required fields", () => {
    const result: SearchResult = { id: "abc-123", score: 0.95 };
    expect(result.id).toBe("abc-123");
    expect(result.score).toBe(0.95);
  });

  it("accepts numeric id", () => {
    const result: SearchResult = { id: 42, score: 0.8 };
    expect(result.id).toBe(42);
  });

  it("accepts payload and rankingOverlay", () => {
    const result: SearchResult = {
      id: "abc",
      score: 0.9,
      payload: { relativePath: "src/index.ts", language: "typescript" },
      rankingOverlay: {
        preset: "techDebt",
        derived: { recency: 0.3, churn: 0.8 },
        file: { ageDays: 142 },
      },
    };
    expect(result.rankingOverlay?.preset).toBe("techDebt");
  });
});

describe("SearchCodeResult", () => {
  it("has all required fields", () => {
    const result: SearchCodeResult = {
      content: "function auth() {}",
      filePath: "/project/src/auth.ts",
      startLine: 1,
      endLine: 3,
      language: "typescript",
      score: 0.92,
      fileExtension: ".ts",
    };
    expect(result.filePath).toBe("/project/src/auth.ts");
  });

  it("accepts optional metadata", () => {
    const result: SearchCodeResult = {
      content: "code",
      filePath: "/a.ts",
      startLine: 1,
      endLine: 1,
      language: "typescript",
      score: 0.5,
      fileExtension: ".ts",
      metadata: { git: { file: { ageDays: 42 } } },
    };
    expect(result.metadata).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Search response types
// ---------------------------------------------------------------------------

describe("SearchResponse", () => {
  it("contains results array and driftWarning", () => {
    const response: SearchResponse = {
      results: [{ id: "1", score: 0.9 }],
      driftWarning: null,
    };
    expect(response.results).toHaveLength(1);
    expect(response.driftWarning).toBeNull();
  });

  it("accepts string drift warning", () => {
    const response: SearchResponse = {
      results: [],
      driftWarning: "Schema drift detected: new fields [bugFixRate]",
    };
    expect(response.driftWarning).toBeTruthy();
  });

  it("accepts null drift warning", () => {
    const response: SearchResponse = {
      results: [],
      driftWarning: null,
    };
    expect(response.driftWarning).toBeNull();
  });
});

describe("SearchCodeResponse", () => {
  it("contains results array and driftWarning", () => {
    const response: SearchCodeResponse = {
      results: [
        {
          content: "code",
          filePath: "/a.ts",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          score: 0.5,
          fileExtension: ".ts",
        },
      ],
      driftWarning: null,
    };
    expect(response.results).toHaveLength(1);
    expect(response.driftWarning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Collection types
// ---------------------------------------------------------------------------

describe("CreateCollectionRequest", () => {
  it("requires name", () => {
    const req: CreateCollectionRequest = { name: "my_collection" };
    expect(req.name).toBe("my_collection");
  });

  it("accepts optional distance and enableHybrid", () => {
    const req: CreateCollectionRequest = {
      name: "test",
      distance: "Dot",
      enableHybrid: true,
    };
    expect(req.distance).toBe("Dot");
    expect(req.enableHybrid).toBe(true);
  });
});

describe("CollectionInfo", () => {
  it("has all required fields", () => {
    const info: CollectionInfo = {
      name: "code_abc",
      vectorSize: 384,
      pointsCount: 1500,
      distance: "Cosine",
    };
    expect(info.vectorSize).toBe(384);
  });

  it("accepts optional hybridEnabled", () => {
    const info: CollectionInfo = {
      name: "code_abc",
      vectorSize: 384,
      pointsCount: 1500,
      distance: "Cosine",
      hybridEnabled: true,
    };
    expect(info.hybridEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

describe("AddDocumentsRequest", () => {
  it("requires collection and documents", () => {
    const req: AddDocumentsRequest = {
      collection: "test",
      documents: [{ id: "doc1", text: "Hello world" }],
    };
    expect(req.documents).toHaveLength(1);
  });

  it("documents accept optional metadata", () => {
    const req: AddDocumentsRequest = {
      collection: "test",
      documents: [
        { id: 1, text: "doc", metadata: { source: "file.ts" } },
        { id: "2", text: "doc2" },
      ],
    };
    expect(req.documents[0].metadata).toEqual({ source: "file.ts" });
  });
});

describe("DeleteDocumentsRequest", () => {
  it("requires collection and ids", () => {
    const req: DeleteDocumentsRequest = {
      collection: "test",
      ids: ["doc1", 2, "doc3"],
    };
    expect(req.ids).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Schema descriptor types
// ---------------------------------------------------------------------------

describe("SignalDescriptor", () => {
  it("has name and description", () => {
    const desc: SignalDescriptor = { name: "recency", description: "Inverse of age" };
    expect(desc.name).toBe("recency");
  });
});

describe("PresetDescriptors", () => {
  it("has presetNames and signalDescriptors", () => {
    const descriptors: PresetDescriptors = {
      presetNames: {
        semantic_search: ["relevance", "techDebt"],
        search_code: ["relevance", "recent"],
      },
      signalDescriptors: [
        { name: "recency", description: "Inverse of age" },
        { name: "churn", description: "Commit frequency" },
      ],
    };
    expect(descriptors.presetNames.semantic_search).toHaveLength(2);
    expect(descriptors.signalDescriptors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Re-exported domain types
// ---------------------------------------------------------------------------

describe("Re-exported domain types", () => {
  it("IndexOptions is accessible", () => {
    const opts: IndexOptions = { forceReindex: true };
    expect(opts.forceReindex).toBe(true);
  });

  it("IndexStats is accessible", () => {
    const stats: IndexStats = {
      filesScanned: 100,
      filesIndexed: 95,
      chunksCreated: 500,
      durationMs: 1234,
      status: "completed",
    };
    expect(stats.status).toBe("completed");
  });

  it("IndexStatus is accessible", () => {
    const status: IndexStatus = {
      isIndexed: true,
      status: "indexed",
      collectionName: "code_abc",
    };
    expect(status.status).toBe("indexed");
  });

  it("ChangeStats is accessible", () => {
    const stats: ChangeStats = {
      filesAdded: 2,
      filesModified: 3,
      filesDeleted: 1,
      chunksAdded: 10,
      chunksDeleted: 5,
      durationMs: 500,
      status: "completed",
    };
    expect(stats.status).toBe("completed");
  });

  it("ProgressCallback is accessible", () => {
    const cb: ProgressCallback = (progress) => {
      void progress;
    };
    expect(typeof cb).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// App interface structural test
// ---------------------------------------------------------------------------

describe("App interface", () => {
  it("defines all expected method signatures", () => {
    // This test verifies at compile time that App has the correct method signatures.
    // We create a type that extracts all method names and verify the set.
    type AppMethodNames = keyof App;
    const _methods: Record<AppMethodNames, true> = {
      semanticSearch: true,
      hybridSearch: true,
      rankChunks: true,
      searchCode: true,
      indexCodebase: true,
      reindexChanges: true,
      getIndexStatus: true,
      clearIndex: true,
      createCollection: true,
      listCollections: true,
      getCollectionInfo: true,
      deleteCollection: true,
      addDocuments: true,
      deleteDocuments: true,
      getSchemaDescriptors: true,
      checkSchemaDrift: true,
    };
    expect(Object.keys(_methods)).toHaveLength(16);
  });

  it("method return types are Promises (except getSchemaDescriptors)", () => {
    // Compile-time assertion: all async methods return Promise
    type AssertPromise<T> = T extends Promise<unknown> ? true : false;

    const _assertions: {
      semanticSearch: AssertPromise<ReturnType<App["semanticSearch"]>>;
      hybridSearch: AssertPromise<ReturnType<App["hybridSearch"]>>;
      rankChunks: AssertPromise<ReturnType<App["rankChunks"]>>;
      searchCode: AssertPromise<ReturnType<App["searchCode"]>>;
      indexCodebase: AssertPromise<ReturnType<App["indexCodebase"]>>;
      reindexChanges: AssertPromise<ReturnType<App["reindexChanges"]>>;
      getIndexStatus: AssertPromise<ReturnType<App["getIndexStatus"]>>;
      clearIndex: AssertPromise<ReturnType<App["clearIndex"]>>;
      createCollection: AssertPromise<ReturnType<App["createCollection"]>>;
      listCollections: AssertPromise<ReturnType<App["listCollections"]>>;
      getCollectionInfo: AssertPromise<ReturnType<App["getCollectionInfo"]>>;
      deleteCollection: AssertPromise<ReturnType<App["deleteCollection"]>>;
      addDocuments: AssertPromise<ReturnType<App["addDocuments"]>>;
      deleteDocuments: AssertPromise<ReturnType<App["deleteDocuments"]>>;
      checkSchemaDrift: AssertPromise<ReturnType<App["checkSchemaDrift"]>>;
    } = {
      semanticSearch: true,
      hybridSearch: true,
      rankChunks: true,
      searchCode: true,
      indexCodebase: true,
      reindexChanges: true,
      getIndexStatus: true,
      clearIndex: true,
      createCollection: true,
      listCollections: true,
      getCollectionInfo: true,
      deleteCollection: true,
      addDocuments: true,
      deleteDocuments: true,
      checkSchemaDrift: true,
    };
    expect(Object.values(_assertions).every((v) => v === true)).toBe(true);
  });

  it("getSchemaDescriptors returns synchronously", () => {
    // Compile-time: getSchemaDescriptors returns PresetDescriptors, not Promise
    type IsSyncReturn = ReturnType<App["getSchemaDescriptors"]> extends PresetDescriptors ? true : false;
    const _sync: IsSyncReturn = true;
    expect(_sync).toBe(true);
  });
});
