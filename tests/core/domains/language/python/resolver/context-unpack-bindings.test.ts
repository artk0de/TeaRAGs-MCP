/**
 * P1 binding forms beyond iteration, resolver half (bd tea-rags-mcp-m99j1.1.18,
 * Task 16b).
 *
 * A `with X(...) as name` target (`contextEnter`) is what `X.__enter__`
 * returns — read through the member-return walk, so an inherited `__enter__`
 * counts — and nothing when no project class declares one. A tuple-unpacking
 * target (`tupleElement`) is the value its expression evaluates to, or that
 * value's position when the walker recorded one. A binding neither fold types
 * is UNTYPED: it never lets a binding from above speak for the rebound name.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  LocalBinding,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonExternalVocabulary } from "../../../../../../src/core/domains/language/python/resolver/python-external-vocabulary.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return table;
}

const instance = (name: string): TypeRef => ({ form: "instance", name });

const derived = (
  valueKind: "contextEnter" | "tupleElement",
  line: number,
  sourceExpression: string,
  tupleIndex?: number,
): LocalBinding => ({
  line,
  type: "",
  valueKind,
  sourceExpression,
  ...(tupleIndex === undefined ? {} : { tupleIndex }),
  endLine: line,
});

const call = (receiver: string, member: string, startLine: number): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const resolve = (ref: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
  new PythonCallResolver().resolve(ref, ctx);

const LOCKS_FILE = "app/locks.py";
const LOCKS_TABLE = {
  [LOCKS_FILE]: ["Worker", "Worker#run", "Lock", "Lock#__enter__", "Lock#release", "Guard", "Guard#release"],
};

describe("Python context-manager bindings — `with X() as name` binds `X.__enter__`'s return", () => {
  it("`with Lock() as l` where `__enter__` returns the instance → Lock#release", () => {
    const ctx: CallContext = {
      callerFile: LOCKS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(LOCKS_TABLE),
      localBindings: { l: [derived("contextEnter", 10, "Lock()")] },
      structuredReturnTypes: { "Lock#__enter__": instance("Lock") },
    };
    expect(resolve(call("l", "release", 11), ctx)?.targetSymbolId).toBe("Lock#release");
  });

  it("`__enter__` returning another class types the target as that class", () => {
    const ctx: CallContext = {
      callerFile: LOCKS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(LOCKS_TABLE),
      localBindings: { g: [derived("contextEnter", 10, "Lock()")] },
      structuredReturnTypes: { "Lock#__enter__": instance("Guard") },
    };
    expect(resolve(call("g", "release", 11), ctx)?.targetSymbolId).toBe("Guard#release");
  });

  it("an `__enter__` inherited through the MRO counts", () => {
    const ctx: CallContext = {
      callerFile: LOCKS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith({
        [LOCKS_FILE]: ["Worker", "Worker#run", "BaseLock", "BaseLock#__enter__", "RLock", "RLock#release"],
      }),
      classAncestors: { [`${LOCKS_FILE}::RLock`]: ["BaseLock"] },
      localBindings: { l: [derived("contextEnter", 10, "RLock()")] },
      // `def __enter__(self) -> Self` on the base names the RECEIVER's class.
      structuredReturnTypes: { "BaseLock#__enter__": instance("Self") },
    };
    expect(resolve(call("l", "release", 11), ctx)?.targetSymbolId).toBe("RLock#release");
  });

  it("`with Client() as c` where `__enter__(self: T) -> T` records the Self marker → Client#request", () => {
    const clientFile = "app/client.py";
    const ctx: CallContext = {
      callerFile: "app/api.py",
      callerScope: ["request"],
      imports: [{ importText: "from app.client import Client", startLine: 1 }],
      symbolTable: tableWith({
        "app/api.py": ["request"],
        [clientFile]: ["Client", "Client#__enter__", "Client#request"],
      }),
      localBindings: { c: [derived("contextEnter", 10, "Client()")] },
      // The marker the annotation pass writes for a self-typed TypeVar return.
      structuredReturnTypes: { "Client#__enter__": instance("Self") },
    };
    expect(resolve(call("c", "request", 11), ctx)?.targetSymbolId).toBe("Client#request");
  });

  // bd tea-rags-mcp-m99j1.1.87 — polar `JobQueueManager.open`:
  // `@classmethod @contextlib.asynccontextmanager def open(cls) -> AsyncIterator[Self]`.
  describe("a `@contextmanager` generator binds its yielded element", () => {
    const QUEUE_FILE = "app/queue.py";
    const queueCtx = (open: TypeRef): CallContext => ({
      callerFile: "app/script.py",
      callerScope: ["run"],
      imports: [{ importText: "from app.queue import JobQueueManager", startLine: 1 }],
      symbolTable: tableWith({
        "app/script.py": ["run"],
        [QUEUE_FILE]: ["JobQueueManager", "JobQueueManager.open", "JobQueueManager#flush"],
      }),
      localBindings: { m: [derived("contextEnter", 10, "JobQueueManager.open(broker, redis)")] },
      structuredReturnTypes: { "JobQueueManager.open": open },
    });
    const manager = (name: string, element: TypeRef): TypeRef => ({ form: "instance", name, args: [element] });

    it("`async with JobQueueManager.open(...) as m` → the Self element, substituted with the receiver class", () => {
      const ctx = queueCtx(manager("contextlib._AsyncGeneratorContextManager", instance("Self")));
      expect(resolve(call("m", "flush", 11), ctx)?.targetSymbolId).toBe("JobQueueManager#flush");
    });

    it("the sync manager reads its element the same way", () => {
      const ctx = queueCtx(manager("contextlib._GeneratorContextManager", instance("JobQueueManager")));
      expect(resolve(call("m", "flush", 11), ctx)?.targetSymbolId).toBe("JobQueueManager#flush");
    });

    it("an undecorated generator's container return still binds nothing", () => {
      const ctx = queueCtx({ form: "container", element: instance("Self") });
      expect(resolve(call("m", "flush", 11), ctx)?.targetSymbolId).not.toBe("JobQueueManager#flush");
    });

    it("a `None` element binds nothing", () => {
      const ctx = queueCtx(manager("contextlib._GeneratorContextManager", { form: "nil" }));
      expect(resolve(call("m", "flush", 11), ctx)?.targetSymbolId).not.toBe("JobQueueManager#flush");
    });
  });

  it("a context value read off a local follows the local's type", () => {
    const ctx: CallContext = {
      callerFile: LOCKS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(LOCKS_TABLE),
      localBindings: {
        lock: [{ line: 9, type: "Lock" }],
        l: [derived("contextEnter", 10, "lock")],
      },
      structuredReturnTypes: { "Lock#__enter__": instance("Lock") },
    };
    expect(resolve(call("l", "release", 11), ctx)?.targetSymbolId).toBe("Lock#release");
  });

  it("no project `__enter__` ⇒ no type, and the binding above no longer speaks for the name", () => {
    const ctx: CallContext = {
      callerFile: LOCKS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith({ [LOCKS_FILE]: ["Worker", "Worker#run", "Guard", "Guard#release"] }),
      // `l = Guard()` above, then `with open(path) as l:` rebinds it.
      localBindings: { l: [{ line: 9, type: "Guard" }, derived("contextEnter", 10, "open(path)")] },
    };
    expect(resolve(call("l", "release", 11), ctx)?.targetSymbolId).not.toBe("Guard#release");
  });

  it("an unfolded context target is untyped for the coreAmbiguous bucket; a folded one is typed", () => {
    const vocabulary = new PythonExternalVocabulary(new PythonImportFileMapper());
    const ctx: CallContext = {
      callerFile: LOCKS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(LOCKS_TABLE),
      localBindings: {
        fh: [derived("contextEnter", 10, "open(path)")],
        l: [derived("contextEnter", 10, "Lock()")],
      },
      structuredReturnTypes: { "Lock#__enter__": instance("Lock") },
    };
    expect(vocabulary.isReceiverTyped("fh", ctx, 11)).toBe(false);
    expect(vocabulary.isReceiverTyped("l", ctx, 11)).toBe(true);
  });
});

describe("Python tuple-unpacking bindings — `a, b = <expr>` binds each position", () => {
  const PAIRS_FILE = "app/pairs.py";
  const PAIRS_TABLE = {
    [PAIRS_FILE]: ["Worker", "Worker#run", "make_pair", "A", "A#x", "B", "B#x"],
  };

  it("`a, b = make_pair()` with `-> tuple[A, B]` → `b.x` resolves to B#x", () => {
    const ctx: CallContext = {
      callerFile: PAIRS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(PAIRS_TABLE),
      localBindings: {
        a: [derived("tupleElement", 10, "make_pair()", 0)],
        b: [derived("tupleElement", 10, "make_pair()", 1)],
      },
      // A module-level def's return is keyed `<relPath>::<name>`.
      structuredReturnTypes: {
        [`${PAIRS_FILE}::make_pair`]: { form: "tuple", elements: [instance("A"), instance("B")] },
      },
    };
    expect(resolve(call("b", "x", 11), ctx)?.targetSymbolId).toBe("B#x");
    expect(resolve(call("a", "x", 11), ctx)?.targetSymbolId).toBe("A#x");
  });

  it("a literal tuple's element binds the name to that element's own type", () => {
    const ctx: CallContext = {
      callerFile: PAIRS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(PAIRS_TABLE),
      localBindings: {
        other: [{ line: 9, type: "A" }],
        left: [derived("tupleElement", 10, "B()")],
        right: [derived("tupleElement", 10, "other")],
      },
    };
    expect(resolve(call("left", "x", 11), ctx)?.targetSymbolId).toBe("B#x");
    expect(resolve(call("right", "x", 11), ctx)?.targetSymbolId).toBe("A#x");
  });

  it("an untyped unpacked value leaves the name untyped, not typed by the binding above", () => {
    const ctx: CallContext = {
      callerFile: PAIRS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(PAIRS_TABLE),
      // `b = B()` above, then `a, b = unknown()` rebinds it.
      localBindings: { b: [{ line: 9, type: "B" }, derived("tupleElement", 10, "unknown()", 1)] },
    };
    expect(resolve(call("b", "x", 11), ctx)?.targetSymbolId).not.toBe("B#x");
  });

  it("a typed binding on the same line outranks the unpacking site", () => {
    const ctx: CallContext = {
      callerFile: PAIRS_FILE,
      callerScope: ["Worker", "run"],
      imports: [],
      symbolTable: tableWith(PAIRS_TABLE),
      localBindings: { b: [derived("tupleElement", 10, "unknown()", 1), { line: 10, type: "B" }] },
    };
    expect(resolve(call("b", "x", 11), ctx)?.targetSymbolId).toBe("B#x");
  });
});
