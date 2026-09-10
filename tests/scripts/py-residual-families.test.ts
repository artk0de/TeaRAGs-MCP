/**
 * Family attribution is what D8 orders E4.1–E4.6 by, so every family carries at
 * least two fixture rows drawn from the corpora it was measured on (polar,
 * netbox, flask). The PRECEDENCE is the part that moves counts silently, so the
 * cases that could match two families assert which one wins.
 */
import { describe, expect, it } from "vitest";

import {
  classifyResidualFamily,
  PY_FAMILY_INCREMENT,
  PY_RESIDUAL_FAMILIES,
  receiverHead,
  receiverTail,
  type PyResidualFamily,
  type PyResidualRow,
  type PyResidualSourceView,
} from "../../scripts/lib/py-residual-families.js";

interface ViewFacts {
  imports?: string[];
  binding?: Record<string, string>;
  typeVars?: string[];
  returns?: string | null;
  params?: string[];
  protocols?: string[];
  fixtures?: string[];
}

function makeView(facts: ViewFacts = {}): PyResidualSourceView {
  return {
    importBindings: () => new Set(facts.imports ?? []),
    bindingLine: (_relPath, _line, name) => facts.binding?.[name] ?? null,
    typeVarNames: () => new Set(facts.typeVars ?? []),
    enclosingReturnAnnotation: () => facts.returns ?? null,
    enclosingDefParams: () => new Set(facts.params ?? []),
    isProtocolClass: (name) => (facts.protocols ?? []).includes(name),
    isProjectFixture: (name) => (facts.fixtures ?? []).includes(name),
  };
}

function row(overrides: Partial<PyResidualRow>): PyResidualRow {
  return {
    relPath: "pkg/mod.py",
    startLine: 10,
    callText: "obj.method()",
    receiver: "obj",
    member: "method",
    receiverKind: "dynamic",
    verdict: "missed",
    categories: [],
    oracleTargetRelPath: "pkg/other.py",
    oracleTargetSymbolId: "Other#method",
    ...overrides,
  };
}

const CASES: { family: PyResidualFamily; label: string; row: Partial<PyResidualRow>; facts?: ViewFacts }[] = [
  { family: "runtimeOnly", label: "getattr dispatch", row: { callText: "getattr(obj, name)()", member: "getattr" } },
  {
    family: "runtimeOnly",
    label: "__getattr__ proxy",
    row: { member: "__getattr__", callText: "proxy.__getattr__(k)" },
  },
  {
    family: "pytestFixture",
    label: "fixture parameter receiver",
    row: { receiver: "client", callText: "client.get('/')" },
    facts: { fixtures: ["client"], params: ["client"] },
  },
  {
    family: "pytestFixture",
    label: "async fixture parameter",
    row: { receiver: "session", callText: "session.commit()" },
    facts: { fixtures: ["session"], params: ["session"] },
  },
  { family: "celeryEnqueue", label: ".delay", row: { member: "delay", callText: "send_mail.delay(id)" } },
  { family: "celeryEnqueue", label: ".apply_async", row: { member: "apply_async", callText: "t.apply_async()" } },
  {
    family: "drfViewAttr",
    label: "self.get_serializer",
    row: { receiver: "self", member: "get_serializer", callText: "self.get_serializer(data)" },
  },
  {
    family: "drfViewAttr",
    label: "self.request.user",
    row: { receiver: "self.request.user", member: "has_perm", callText: "self.request.user.has_perm(p)" },
  },
  {
    family: "djangoUrlRoute",
    label: "as_view in a urls module",
    row: { relPath: "app/urls.py", member: "as_view", receiverKind: "constant", callText: "views.Index.as_view()" },
  },
  {
    family: "djangoUrlRoute",
    label: "path() in urls.py",
    row: {
      relPath: "app/urls.py",
      member: "path",
      receiver: null,
      receiverKind: "bareCall",
      callText: 'path("x/", v)',
    },
  },
  {
    family: "pydanticRow",
    label: "model_validate",
    row: { member: "model_validate", callText: "M.model_validate(d)" },
  },
  { family: "pydanticRow", label: "model_dump", row: { member: "model_dump", callText: "m.model_dump()" } },
  {
    family: "sqlalchemyRow",
    label: "session receiver",
    row: { receiver: "session", member: "execute", callText: "session.execute(stmt)" },
  },
  {
    family: "sqlalchemyRow",
    label: "select() head",
    row: { receiver: null, receiverKind: "bareCall", member: "select", callText: "select(Order)" },
  },
  {
    family: "superMro",
    label: "super().__init__",
    row: { receiver: "super", receiverKind: "super", member: "__init__", callText: "super().__init__(a)" },
  },
  {
    family: "superMro",
    label: "superMro category",
    row: { receiverKind: "localVar", categories: ["superMro"], callText: "super().save()" },
  },
  {
    family: "constructorChainHead",
    label: "Model(...).save()",
    row: { receiver: "Notification(\n  user=self.user,\n)", receiverKind: "chain", member: "save" },
  },
  {
    family: "constructorChainHead",
    label: "generic subscript constructor",
    row: { receiver: "datatable.Datatable[Benefit](\n  col,\n)", receiverKind: "index", member: "render" },
  },
  {
    family: "callResultChainHead",
    label: "function-result head",
    row: { receiver: "get_client()", receiverKind: "dynamic", member: "get" },
  },
  {
    family: "callResultChainHead",
    label: "typing.cast head",
    row: { receiver: "typing.cast(Mixin, self)", receiverKind: "dynamic", member: "get_email" },
  },
  {
    family: "containerElementHop",
    label: "dict subscript receiver",
    row: { receiver: "S3_SERVICES[service]", receiverKind: "index", member: "get_object" },
  },
  {
    family: "containerElementHop",
    label: "list subscript receiver",
    row: { receiver: "queue[key]", receiverKind: "index", member: "freeze_data" },
  },
  {
    family: "asyncForm",
    label: "awaited receiver",
    row: { callText: "(await client()).send(req)", receiver: "(await client())", receiverKind: "dynamic" },
  },
  {
    family: "asyncForm",
    label: "asyncio.gather result",
    row: { callText: "asyncio.gather(a(), b())", receiver: "asyncio", receiverKind: "dynamic" },
  },
  {
    family: "moduleAliasMember",
    label: "from pkg import submodule",
    row: { receiver: "datatable", receiverKind: "dynamic", member: "DatatableAttrColumn" },
    facts: { imports: ["datatable"] },
  },
  {
    family: "moduleAliasMember",
    label: "netbox layout alias",
    row: { receiver: "layout", receiverKind: "localVar", member: "Row" },
    facts: { imports: ["layout"] },
  },
  {
    family: "transparentWrapper",
    label: "Mapped[T] field",
    row: { receiver: "self.status", receiverKind: "chain", member: "get_display" },
    facts: { binding: { status: "    status: Mapped[Status] = mapped_column()" } },
  },
  {
    family: "transparentWrapper",
    label: "Annotated[T, …] parameter",
    row: { receiver: "params", receiverKind: "localVar", member: "resolve" },
    facts: { binding: { params: "    params: Annotated[Params, Depends()]," } },
  },
  {
    family: "unionBranchReceiver",
    label: "PEP 604 union annotation",
    row: { receiver: "price", receiverKind: "localVar", member: "get_unit_noun" },
    facts: { binding: { price: "    price: ProductPriceUnit | ProductPriceFixed," } },
  },
  {
    family: "unionBranchReceiver",
    label: "ternary binding",
    row: { receiver: "backend", receiverKind: "localVar", member: "send" },
    facts: { binding: { backend: "    backend = Smtp() if cfg else Console()" } },
  },
  {
    family: "protocolReceiver",
    label: "Protocol-annotated parameter",
    row: { receiver: "sink", receiverKind: "localVar", member: "write" },
    facts: { binding: { sink: "    sink: Writable," }, protocols: ["Writable"] },
  },
  {
    family: "protocolReceiver",
    label: "Protocol-annotated attribute",
    row: { receiver: "self.store", receiverKind: "chain", member: "put" },
    facts: { binding: { store: "    store: BlobStore" }, protocols: ["BlobStore"] },
  },
  {
    family: "typeVarGeneric",
    label: "TypeVar-annotated binding",
    row: { receiver: "item", receiverKind: "localVar", member: "clone" },
    facts: { binding: { item: "    item: T," }, typeVars: ["T"] },
  },
  {
    family: "typeVarGeneric",
    label: "-> Self return",
    row: { receiver: "built", receiverKind: "localVar", member: "run" },
    facts: { returns: "Self" },
  },
  {
    family: "classObjectReceiver",
    label: "cls(...) construction",
    row: { receiver: null, receiverKind: "bareCall", member: "cls", callText: "cls(a, b)" },
  },
  {
    family: "classObjectReceiver",
    label: "class-object receiver",
    row: { receiver: "UpdateForm", receiverKind: "constant", member: "render" },
  },
  {
    family: "untypedFieldHop",
    label: "self.<field> with no type fact",
    row: { receiver: "self.payment_repo", receiverKind: "chain", member: "get_base_statement" },
  },
  {
    family: "untypedFieldHop",
    label: "nested attribute hop",
    row: { receiver: "self.payout_account.type", receiverKind: "chain", member: "get_display_name" },
  },
  {
    family: "sameFileBareCall",
    label: "callee def in the caller's own file",
    row: {
      receiver: null,
      receiverKind: "bareCall",
      member: "prompt_setup",
      callText: "prompt_setup()",
      oracleTargetRelPath: "pkg/mod.py",
    },
  },
  {
    family: "sameFileBareCall",
    label: "nested def in the same file",
    row: {
      receiver: null,
      receiverKind: "bareCall",
      member: "set_status",
      callText: 'set_status("go")',
      oracleTargetRelPath: "pkg/mod.py",
    },
  },
  {
    family: "crossFileBareCall",
    label: "bare call answered in another file",
    row: {
      receiver: null,
      receiverKind: "bareCall",
      member: "generate_checkout_data",
      callText: "generate_checkout_data()",
    },
  },
  {
    family: "crossFileBareCall",
    label: "bare call with no oracle file",
    row: {
      receiver: null,
      receiverKind: "bareCall",
      member: "helper",
      callText: "helper()",
      oracleTargetRelPath: null,
    },
  },
  {
    family: "untypedNameReceiver",
    label: "untyped local name",
    row: { receiver: "datasource", receiverKind: "dynamic", member: "sync", callText: "datasource.sync()" },
  },
  {
    family: "untypedNameReceiver",
    label: "untyped localVar name",
    row: { receiver: "action", receiverKind: "localVar", member: "render", callText: "action.render(req)" },
  },
  {
    family: "other",
    label: "kind no family claims",
    row: { receiver: "thing", receiverKind: "keywordArg", member: "go", callText: "thing.go()" },
  },
  {
    family: "other",
    label: "empty receiver on a non-bare kind",
    row: { receiver: null, receiverKind: "unknownKind", member: "go", callText: "go()" },
  },
];

describe("classifyResidualFamily", () => {
  for (const testCase of CASES) {
    it(`attributes ${testCase.label} to ${testCase.family}`, () => {
      expect(classifyResidualFamily(row(testCase.row), makeView(testCase.facts)).family).toBe(testCase.family);
    });
  }

  it("covers every family with at least two fixture rows", () => {
    const counts = new Map<string, number>();
    for (const testCase of CASES) counts.set(testCase.family, (counts.get(testCase.family) ?? 0) + 1);
    const thin = PY_RESIDUAL_FAMILIES.filter((family) => (counts.get(family) ?? 0) < 2);
    expect(thin).toEqual([]);
  });

  it("names an increment for every family", () => {
    const missing = PY_RESIDUAL_FAMILIES.filter((family) => PY_FAMILY_INCREMENT[family] === undefined);
    expect(missing).toEqual([]);
  });
});

describe("precedence", () => {
  it("prefers the framework family over the shape one — .delay beats a call-result head", () => {
    const attributed = classifyResidualFamily(
      row({ receiver: "get_task()", receiverKind: "dynamic", member: "delay", callText: "get_task().delay(id)" }),
      makeView(),
    );
    expect(attributed.family).toBe("celeryEnqueue");
  });

  it("prefers superMro over a constructor head — super() is a call receiver too", () => {
    const attributed = classifyResidualFamily(
      row({ receiver: "super()", receiverKind: "super", member: "__init__", callText: "super().__init__()" }),
      makeView(),
    );
    expect(attributed.family).toBe("superMro");
  });

  it("types a DOTTED receiver by its last segment, not by its head", () => {
    const attributed = classifyResidualFamily(
      row({ receiver: "item.type", receiverKind: "chain", member: "get_display_name" }),
      makeView({ binding: { item: "    item: Benefit | Order,", type: "    type: Mapped[BenefitType]" } }),
    );
    expect(attributed.family).toBe("transparentWrapper");
  });

  it("leaves flask's own View.as_view outside the route family", () => {
    const attributed = classifyResidualFamily(
      row({ relPath: "tests/test_async.py", receiverKind: "constant", member: "as_view", callText: 'V.as_view("v")' }),
      makeView(),
    );
    expect(attributed.family).toBe("classObjectReceiver");
  });

  it("reports a binding-line miss rather than inventing a family", () => {
    const attributed = classifyResidualFamily(
      row({ receiver: "mystery", receiverKind: "dynamic", member: "go" }),
      makeView(),
    );
    expect(attributed).toEqual({ family: "untypedNameReceiver", tier: 2, bindingFound: false });
  });
});

describe("receiver helpers", () => {
  it("reads the head off a dotted, called or subscripted receiver", () => {
    expect(receiverHead("self.repo.get")).toBe("self");
    expect(receiverHead("datatable")).toBe("datatable");
    expect(receiverHead("get_client()")).toBe("get_client");
    expect(receiverHead(null)).toBe("");
  });

  it("reads the tail only off a dotted receiver", () => {
    expect(receiverTail("self.payment_repo")).toBe("payment_repo");
    expect(receiverTail("price")).toBe("");
    expect(receiverTail("S3_SERVICES[key]")).toBe("");
  });
});
