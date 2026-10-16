/**
 * Django QuerySet chains resolve on the model's queryset class (bd
 * tea-rags-mcp-2m83f.32.4) — the Python port of the kernel's ORM relation chain.
 *
 * A query verb keeps the receiver's queryset class: `Book.objects.filter(...)`
 * on `objects = BookQuerySet.as_manager()` is still a `BookQuerySet`, and a
 * manager built by `from_queryset` hands out the queryset it copied. A relation
 * the fold only knows as Django's own `QuerySet[Book]` forwards a custom method
 * to the queryset class one of `Book`'s managers carries.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const MODELS = "app/models.py";
const FEATURES = "app/features.py";
const VIEWS = "app/views.py";
const DJANGO: ReadonlySet<string> = new Set(["django"]);
const FLASK_ONLY: ReadonlySet<string> = new Set(["flask"]);

const SOURCES: Record<string, readonly string[]> = {
  [MODELS]: [
    "from django.db import models",
    "class BookQuerySet(models.QuerySet):",
    "    def active(self):",
    "        return self.filter(active=True)",
    "class Book(models.Model):",
    "    objects = BookQuerySet.as_manager()",
    "class AuthorQuerySet(models.QuerySet):",
    "    def living(self):",
    "        return self.filter(dead=False)",
    "class AuthorManager(models.Manager.from_queryset(AuthorQuerySet)):",
    "    def published(self):",
    "        return self.get_queryset().filter(has_books=True)",
    "class Author(models.Model):",
    "    objects = AuthorManager()",
  ],
  // A namesake per custom method, so no short-name guess can stand in for typing.
  [FEATURES]: [
    "class Feature:",
    "    def active(self):",
    "        return self.filter(on=True)",
    "    def living(self):",
    "        pass",
  ],
  [VIEWS]: ["from app.models import Author, Book", "def f():", "    pass"],
};

const SYMBOLS: Record<string, readonly string[]> = {
  [MODELS]: [
    "BookQuerySet",
    "BookQuerySet#active",
    "Book",
    "AuthorQuerySet",
    "AuthorQuerySet#living",
    "AuthorManager",
    "AuthorManager#published",
    "Author",
  ],
  [FEATURES]: ["Feature", "Feature#active", "Feature#living"],
  [VIEWS]: ["f"],
};

function walk(relPath: string, declaredDependencies: ReadonlySet<string>): FileExtraction {
  const src = (SOURCES[relPath] ?? []).join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath,
    language: "python",
    chunks: [],
    declaredDependencies,
  });
}

function table(): InMemoryGlobalSymbolTable {
  const out = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(SYMBOLS)) {
    out.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return out;
}

function ctxFor(declaredDependencies: ReadonlySet<string>): CallContext {
  const ctx: CallContext = {
    callerFile: VIEWS,
    callerScope: ["f"],
    imports: [],
    symbolTable: table(),
    classAncestors: {},
    classFieldTypes: {},
    classFieldTypesByClassKey: {},
    structuredReturnTypes: {},
    declaredDependencies,
  };
  for (const relPath of [MODELS, FEATURES, VIEWS]) {
    const out = walk(relPath, declaredDependencies);
    Object.assign(ctx.classAncestors ?? {}, out.classAncestors);
    Object.assign(ctx.classFieldTypes ?? {}, out.classFieldTypes);
    Object.assign(ctx.classFieldTypesByClassKey ?? {}, out.classFieldTypesByClassKey);
    Object.assign(ctx.structuredReturnTypes ?? {}, out.structuredReturnTypes);
    if (relPath === VIEWS) ctx.imports = out.imports.map((i) => ({ ...i }));
  }
  return ctx;
}

function resolve(
  receiver: string,
  member: string,
  declared: ReadonlySet<string> = DJANGO,
): SymbolResolutionTarget | null {
  const ref: CallRef = { callText: `${receiver}.${member}()`, receiver, member, startLine: 3 };
  return new PythonCallResolver().resolve(ref, ctxFor(declared));
}

const ACTIVE = { targetRelPath: MODELS, targetSymbolId: "BookQuerySet#active" };
const LIVING = { targetRelPath: MODELS, targetSymbolId: "AuthorQuerySet#living" };

describe("Django QuerySet chains resolve on the model's queryset class (bd tea-rags-mcp-2m83f.32.4)", () => {
  it("hop one already lands: the manager field is typed as the queryset it was built from", () => {
    expect(resolve("Book.objects", "active")).toEqual(ACTIVE);
    expect(resolve("Author.objects", "living")).toEqual(LIVING);
  });

  it("a verb on an `as_manager` queryset keeps the queryset: `Book.objects.filter(...).active()`", () => {
    expect(resolve("Book.objects.filter(x=1)", "active")).toEqual(ACTIVE);
  });

  it("verbs chain: `Book.objects.filter(...).exclude(...).order_by(...).active()`", () => {
    expect(resolve('Book.objects.filter(x=1).exclude(y=2).order_by("z")', "active")).toEqual(ACTIVE);
  });

  it("a `from_queryset` manager's verb hands out the queryset it copied", () => {
    expect(resolve("Author.objects.filter(x=1)", "living")).toEqual(LIVING);
  });

  it("a custom manager method returning `self.get_queryset().filter(...)` keeps the queryset", () => {
    expect(resolve("Author.objects.published()", "living")).toEqual(LIVING);
  });

  it("Django's own relation of a model forwards to the queryset the model's manager carries", () => {
    expect(resolve("Book._default_manager.exclude(x=1)", "active")).toEqual(ACTIVE);
  });

  it("a terminal verb breaks the chain: `.first()` is a Book, not a queryset", () => {
    expect(resolve("Book.objects.filter(x=1).first()", "active")).not.toEqual(ACTIVE);
  });

  it("a member no manager's queryset declares is no edge", () => {
    expect(resolve("Book._default_manager.exclude(x=1)", "living")).toBeNull();
  });

  it("without Django in the manifest the chain is silent", () => {
    expect(resolve("Book._default_manager.exclude(x=1)", "active", FLASK_ONLY)).not.toEqual(ACTIVE);
    expect(resolve("Author.objects.filter(x=1)", "living", FLASK_ONLY)).not.toEqual(LIVING);
  });
});

describe("a queryset's `return self.<verb>(…)` chain is the receiver (bd tea-rags-mcp-2m83f.32.4)", () => {
  const SELF_RETURN = { form: "instance", name: "Self" };

  it("a queryset method and a `from_queryset` manager method both return the receiver", () => {
    const returns = walk(MODELS, DJANGO).structuredReturnTypes ?? {};
    expect(returns["BookQuerySet#active"]).toEqual(SELF_RETURN);
    expect(returns["AuthorManager#published"]).toEqual(SELF_RETURN);
  });

  it("says nothing without Django in the manifest", () => {
    expect(walk(MODELS, FLASK_ONLY).structuredReturnTypes?.["BookQuerySet#active"]).toBeUndefined();
  });

  it("says nothing in a class whose bases name no relation class", () => {
    const returns = walk(FEATURES, DJANGO).structuredReturnTypes ?? {};
    expect(returns["Feature#active"]).toBeUndefined();
  });
});
