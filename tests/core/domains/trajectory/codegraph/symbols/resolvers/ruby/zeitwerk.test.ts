import { describe, expect, it } from "vitest";

import {
  constantToFilePath,
  resolveZeitwerkConstant,
  snakeCase,
} from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ruby/zeitwerk.js";

describe("snakeCase (Zeitwerk-equivalent underscore)", () => {
  it("simple constant: User → user", () => {
    expect(snakeCase("User")).toBe("user");
  });

  it("CamelCase splits between word boundary: UserProfile → user_profile", () => {
    expect(snakeCase("UserProfile")).toBe("user_profile");
  });

  it("acronyms preserve the uppercase run as a single boundary: HTMLParser → html_parser", () => {
    expect(snakeCase("HTMLParser")).toBe("html_parser");
  });

  it("APIController → api_controller", () => {
    expect(snakeCase("APIController")).toBe("api_controller");
  });

  it("RDocFormatter → r_doc_formatter (each acronym + trailing word)", () => {
    expect(snakeCase("RDocFormatter")).toBe("r_doc_formatter");
  });

  it("digits join with adjacent letter: V2Endpoint → v2_endpoint", () => {
    expect(snakeCase("V2Endpoint")).toBe("v2_endpoint");
  });

  it("single letter constant: A → a", () => {
    expect(snakeCase("A")).toBe("a");
  });
});

describe("constantToFilePath", () => {
  it("single constant becomes <snake>.rb", () => {
    expect(constantToFilePath("User")).toBe("user.rb");
  });

  it("namespaced constant becomes nested dirs: Acme::Auth::User → acme/auth/user.rb", () => {
    expect(constantToFilePath("Acme::Auth::User")).toBe("acme/auth/user.rb");
  });

  it("preserves acronym snake_case for each segment", () => {
    expect(constantToFilePath("API::V2::HTMLParser")).toBe("api/v2/html_parser.rb");
  });
});

describe("resolveZeitwerkConstant", () => {
  it("matches `User` against app/models/user.rb", () => {
    const paths = ["app/models/user.rb", "app/services/order.rb"];
    expect(resolveZeitwerkConstant("User", paths)).toBe("app/models/user.rb");
  });

  it("matches `Acme::Auth::Login` against app/services/acme/auth/login.rb", () => {
    const paths = ["app/services/acme/auth/login.rb", "app/models/user.rb"];
    expect(resolveZeitwerkConstant("Acme::Auth::Login", paths)).toBe("app/services/acme/auth/login.rb");
  });

  it("falls back to lib/<snake>.rb for gem-style layouts", () => {
    const paths = ["lib/foo/bar.rb"];
    expect(resolveZeitwerkConstant("Foo::Bar", paths)).toBe("lib/foo/bar.rb");
  });

  it("basename fallback matches any directory tail", () => {
    const paths = ["custom/path/special/widget.rb"];
    expect(resolveZeitwerkConstant("Widget", paths)).toBe("custom/path/special/widget.rb");
  });

  it("returns null when no path matches", () => {
    const paths = ["app/models/user.rb"];
    expect(resolveZeitwerkConstant("DoesNotExist", paths)).toBeNull();
  });

  it("prefers app/models over basename if both could match", () => {
    const paths = ["app/models/user.rb", "spec/models/user.rb"];
    // app/models wins because it's the first autoload root in the priority list.
    expect(resolveZeitwerkConstant("User", paths)).toBe("app/models/user.rb");
  });

  it("HTMLParser resolves to html_parser.rb in any known root", () => {
    const paths = ["app/parsers/html_parser.rb"];
    // app/parsers isn't in default roots, so basename-fallback finds it.
    expect(resolveZeitwerkConstant("HTMLParser", paths)).toBe("app/parsers/html_parser.rb");
  });
});
