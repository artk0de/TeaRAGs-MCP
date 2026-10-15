import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const CALLER = "src/caller.rs";

const sym = (symbolId: string, relPath: string, scope: string[] = []): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/#|\.|::/).pop() ?? symbolId,
  relPath,
  scope,
});

const call = (callText: string, receiver: string | null, member: string, startLine = 5): CallRef => ({
  callText,
  receiver,
  member,
  startLine,
});

function context(symbols: [string, SymbolDefinition[]][], over: Partial<CallContext> = {}): CallContext {
  const symbolTable = new InMemoryGlobalSymbolTable();
  for (const [path, definitions] of symbols) symbolTable.upsertFile(path, definitions);
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: [],
    symbolTable,
    ...over,
  };
}

describe("RustCallResolver — generic and reference receiver flow (2g2og.6)", () => {
  it("resolves an instance method through a generic parameter bound to a concrete type", () => {
    const ctx = context(
      [
        [
          "src/worker.rs",
          [
            sym("Worker", "src/worker.rs"),
            sym("Worker#run", "src/worker.rs", ["Worker"]),
            sym("Other#run", "src/other.rs", ["Other"]),
          ],
        ],
      ],
      {
        localBindings: {
          worker: [
            {
              line: 1,
              type: "T",
              typeRef: { form: "instance", name: "Worker", upperBound: true },
            },
          ],
        },
      },
    );
    expect(new RustCallResolver().resolve(call("worker.run()", "worker", "run"), ctx)).toEqual({
      targetRelPath: "src/worker.rs",
      targetSymbolId: "Worker#run",
    });
  });

  it("resolves a borrowed parameter receiver as an instance, not an associated member", () => {
    const ctx = context(
      [
        [
          "src/worker.rs",
          [sym("Worker#run", "src/worker.rs", ["Worker"]), sym("Worker.run", "src/worker.rs", ["Worker"])],
        ],
      ],
      {
        localBindings: { worker: [{ line: 1, type: "Worker" }] },
      },
    );
    expect(new RustCallResolver().resolve(call("worker.run()", "worker", "run"), ctx)).toEqual({
      targetRelPath: "src/worker.rs",
      targetSymbolId: "Worker#run",
    });
  });

  it("resolves a turbofish constructor result to the constructed instance method", () => {
    const ctx = context([
      [
        "src/parser.rs",
        [
          sym("Parser", "src/parser.rs"),
          sym("Parser#parse", "src/parser.rs", ["Parser"]),
          sym("Other#parse", "src/other.rs", ["Other"]),
        ],
      ],
    ]);
    expect(
      new RustCallResolver().resolve(call("Parser::<Token>::new().parse()", "Parser::<Token>::new()", "parse"), ctx),
    ).toEqual({ targetRelPath: "src/parser.rs", targetSymbolId: "Parser#parse" });
  });

  it("unwraps a statically recoverable Result-like call before resolving its instance member", () => {
    const ctx = context(
      [["src/document.rs", [sym("load", "src/document.rs"), sym("Document#save", "src/document.rs", ["Document"])]]],
      {
        localBindings: { document: [{ line: 1, type: "" }] },
        callResultBindings: { document: [{ line: 1, callee: "load" }] },
        functionReturnTypes: { load: "Document" },
      },
    );
    expect(new RustCallResolver().resolve(call("document.save()", "document", "save"), ctx)).toEqual({
      targetRelPath: "src/document.rs",
      targetSymbolId: "Document#save",
    });
  });

  it("uses a declared return type only when the callee is uniquely evidenced", () => {
    const ctx = context(
      [["src/document.rs", [sym("load", "src/document.rs"), sym("Document#save", "src/document.rs", ["Document"])]]],
      {
        localBindings: { document: [{ line: 1, type: "" }] },
        callResultBindings: { document: [{ line: 1, callee: "load" }] },
        functionReturnTypes: { load: "Document" },
      },
    );
    expect(new RustCallResolver().resolve(call("document.save()", "document", "save"), ctx)).toEqual({
      targetRelPath: "src/document.rs",
      targetSymbolId: "Document#save",
    });
    expect(
      new RustCallResolver().resolve(
        call("unknown.save()", "unknown", "save"),
        context(
          [
            ["src/document.rs", [sym("Document#save", "src/document.rs", ["Document"])]],
            ["src/image.rs", [sym("Image#save", "src/image.rs", ["Image"])]],
          ],
          {
            callResultBindings: { unknown: [{ line: 1, callee: "load" }] },
            functionReturnTypes: { load: "Document" },
          },
        ),
      ),
    ).toBeNull();
  });

  it("declines an uncertain union receiver instead of choosing one instance member", () => {
    const ctx = context(
      [
        ["src/document.rs", [sym("Document#save", "src/document.rs", ["Document"])]],
        ["src/image.rs", [sym("Image#save", "src/image.rs", ["Image"])]],
      ],
      {
        localBindings: {
          value: [
            {
              line: 1,
              type: "",
              typeRef: {
                form: "union",
                members: [
                  { form: "instance", name: "Document" },
                  { form: "instance", name: "Image" },
                ],
              },
            },
          ],
        },
      },
    );
    expect(new RustCallResolver().resolve(call("value.save()", "value", "save"), ctx)).toBeNull();
  });
});
