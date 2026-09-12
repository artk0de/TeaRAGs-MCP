/**
 * Python dependency-manifest parsing (bd tea-rags-mcp-w205u.1).
 *
 * Ruby answers "is this gem declared?" off the `Gemfile`, parsed with
 * tree-sitter because a Gemfile is Ruby. Python declares the same fact in two
 * unrelated file formats, neither of them Python, and a project may hold many of
 * both — polar's dependencies live in `server/pyproject.toml`, not at the root.
 *
 * The parse here is the NAME half only: every declared distribution, PEP 503
 * normalized, with version specifiers, extras and environment markers stripped.
 * Which files exist and where is the walk's question, not this module's.
 *
 * The netbox shape is the one that makes "read only the four dependency
 * locations" load-bearing: its `[project]` table carries
 * `"Framework :: Django"` in `classifiers` and `dynamic = ["dependencies"]`,
 * so a parser that scanned the table for the substring would activate Django off
 * a trove classifier rather than off a dependency.
 */
import { describe, expect, it } from "vitest";

import {
  normalizePythonPackageName,
  parsePythonManifest,
} from "../../../../../src/core/domains/language/python/manifest.js";

function pyproject(lines: readonly string[]): readonly string[] {
  return parsePythonManifest("pyproject.toml", lines.join("\n"));
}

function requirements(lines: readonly string[], fileName = "requirements.txt"): readonly string[] {
  return parsePythonManifest(fileName, lines.join("\n"));
}

describe("normalizePythonPackageName", () => {
  it("lowercases and folds every run of -, _ and . to a single dash (PEP 503)", () => {
    expect(normalizePythonPackageName("Django")).toBe("django");
    expect(normalizePythonPackageName("django_filter")).toBe("django-filter");
    expect(normalizePythonPackageName("zope.interface")).toBe("zope-interface");
    expect(normalizePythonPackageName("A--_.B")).toBe("a-b");
  });

  it("trims surrounding whitespace so a manifest's indentation never leaks", () => {
    expect(normalizePythonPackageName("  Flask  ")).toBe("flask");
  });
});

describe("parsePythonManifest — pyproject.toml", () => {
  it("reads [project].dependencies across lines, stripping specifiers and extras", () => {
    expect(
      pyproject([
        "[project]",
        'name = "ugnest"',
        "dependencies = [",
        '    "django>=6.0.3",',
        '    "psycopg[binary]==3.2.3",',
        '    "django-storages[s3] == 1.14.4",',
        "]",
      ]),
    ).toEqual(["django", "psycopg", "django-storages"]);
  });

  it("reads a single-line [project].dependencies array", () => {
    expect(pyproject(["[project]", 'dependencies = ["Flask>=3", "itsdangerous"]'])).toEqual(["flask", "itsdangerous"]);
  });

  it("reads every group under [project.optional-dependencies]", () => {
    expect(
      pyproject([
        "[project.optional-dependencies]",
        'ldap = ["django-auth-ldap"]',
        'remote-auth = ["django-auth-ldap", "python3-saml"]',
      ]),
    ).toEqual(["django-auth-ldap", "python3-saml"]);
  });

  it("reads the keys of [tool.poetry.dependencies], skipping the python constraint", () => {
    expect(
      pyproject([
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'Django = "^5.0"',
        'celery = { version = "^5.3", extras = ["redis"] }',
      ]),
    ).toEqual(["django", "celery"]);
  });

  it("reads the keys of every [tool.poetry.group.*.dependencies] table", () => {
    expect(
      pyproject([
        "[tool.poetry.group.dev.dependencies]",
        'pytest = "^8"',
        "[tool.poetry.group.docs.dependencies]",
        'mkdocs = "^1.6"',
      ]),
    ).toEqual(["pytest", "mkdocs"]);
  });

  it("declines every other table — build requires and trove classifiers are not dependencies", () => {
    expect(
      pyproject([
        "[build-system]",
        'requires = ["hatchling>=1.27", "packaging"]',
        "[project]",
        'name = "netbox"',
        'dynamic = ["version", "dependencies"]',
        "classifiers = [",
        '    "Framework :: Django",',
        '    "Programming Language :: Python",',
        "]",
        "[tool.ruff]",
        'target-version = "py312"',
      ]),
    ).toEqual([]);
  });

  it("never throws on garbage", () => {
    expect(parsePythonManifest("pyproject.toml", "[[[ not toml at all")).toEqual([]);
  });
});

describe("parsePythonManifest — requirements files", () => {
  it("strips specifiers, extras, trailing comments and whole-line comments", () => {
    expect(
      requirements([
        "# Django Core",
        "Django==6.0.3",
        "djangorestframework-simplejwt==5.5.1  # JWT authentication",
        "psycopg[binary]==3.2.3  # PostgreSQL adapter",
        "",
        "django-storages[s3]==1.14.4",
      ]),
    ).toEqual(["django", "djangorestframework-simplejwt", "psycopg", "django-storages"]);
  });

  it("strips an environment marker and a PEP 508 direct reference", () => {
    expect(requirements(["tomli ; python_version < '3.11'", "mylib @ git+https://example.com/mylib.git"])).toEqual([
      "tomli",
      "mylib",
    ]);
  });

  it("declines option lines — -r, -e, -c and long options carry no distribution name", () => {
    expect(
      requirements([
        "-r base.txt",
        "--index-url https://example.com/simple",
        "-c constraints.txt",
        "-e .",
        "requests>=2",
      ]),
    ).toEqual(["requests"]);
  });

  it("reads a suffixed requirements file the same way", () => {
    expect(requirements(["pytest-django==4.9.0"], "requirements-dev.txt")).toEqual(["pytest-django"]);
  });
});
