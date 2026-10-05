/**
 * SQLAlchemy's vocabulary (bd tea-rags-mcp-m99j1.1.50).
 *
 * One facet: the decorators SQLAlchemy models use to declare an ATTRIBUTE as a
 * def. `@declared_attr def discount(cls) -> Mapped[Discount | None]` reads as
 * `self.discount`, a `Discount`, exactly as a `relationship` assigned in the
 * class body would; so does a `@hybrid_property`. They are SQLAlchemy's own
 * classes, so where SQLAlchemy is not a dependency the spellings mean nothing.
 * `declared_attr.directive` is the attribute form of the same decorator (the
 * pass qualifies a dotted decorator by its head's import binding), and the
 * `sqlalchemy.ext.declarative` spelling is the pre-2.0 home of `declared_attr`.
 *
 * It activates on the `sqlalchemy` distribution alone, exact PEP 503 name.
 */

import { definePythonFrameworkVocabulary, type PythonFrameworkVocabulary } from "./types.js";

export const SQLALCHEMY_VOCABULARY: PythonFrameworkVocabulary = definePythonFrameworkVocabulary(
  "sqlalchemy",
  ["descriptorDecorators"],
  ["sqlalchemy"],
  undefined,
  [
    "sqlalchemy.orm.declared_attr",
    "sqlalchemy.orm.declared_attr.directive",
    "sqlalchemy.ext.declarative.declared_attr",
    "sqlalchemy.ext.hybrid.hybrid_property",
  ],
);
