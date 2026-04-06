import { describe, expect, it } from "vitest";

import { detectTestFile } from "../../../../../src/core/domains/trajectory/static/test-detection.js";

describe("detectTestFile", () => {
  describe("typescript", () => {
    it("detects .test.ts files", () => {
      expect(detectTestFile("src/utils.test.ts", "typescript")).toBe(true);
    });

    it("detects .spec.ts files", () => {
      expect(detectTestFile("src/utils.spec.ts", "typescript")).toBe(true);
    });

    it("detects .test.tsx files", () => {
      expect(detectTestFile("components/Button.test.tsx", "typescript")).toBe(true);
    });

    it("rejects non-test .ts files", () => {
      expect(detectTestFile("src/utils.ts", "typescript")).toBe(false);
    });

    it("rejects files with test in directory but not filename", () => {
      expect(detectTestFile("tests/helpers/setup.ts", "typescript")).toBe(false);
    });
  });

  describe("javascript", () => {
    it("detects .test.js files", () => {
      expect(detectTestFile("src/app.test.js", "javascript")).toBe(true);
    });

    it("detects .spec.jsx files", () => {
      expect(detectTestFile("src/App.spec.jsx", "javascript")).toBe(true);
    });

    it("rejects non-test .js files", () => {
      expect(detectTestFile("src/app.js", "javascript")).toBe(false);
    });
  });

  describe("python", () => {
    it("detects test_ prefixed files", () => {
      expect(detectTestFile("tests/test_utils.py", "python")).toBe(true);
    });

    it("detects _test suffixed files", () => {
      expect(detectTestFile("src/utils_test.py", "python")).toBe(true);
    });

    it("rejects non-test .py files", () => {
      expect(detectTestFile("src/utils.py", "python")).toBe(false);
    });
  });

  describe("java", () => {
    it("detects Test suffixed files", () => {
      expect(detectTestFile("src/UserServiceTest.java", "java")).toBe(true);
    });

    it("detects IT suffixed files", () => {
      expect(detectTestFile("src/UserServiceIT.java", "java")).toBe(true);
    });

    it("rejects non-test .java files", () => {
      expect(detectTestFile("src/UserService.java", "java")).toBe(false);
    });
  });

  describe("go", () => {
    it("detects _test.go files", () => {
      expect(detectTestFile("pkg/utils_test.go", "go")).toBe(true);
    });

    it("rejects non-test .go files", () => {
      expect(detectTestFile("pkg/utils.go", "go")).toBe(false);
    });
  });

  describe("rust", () => {
    it("detects _test.rs files", () => {
      expect(detectTestFile("src/utils_test.rs", "rust")).toBe(true);
    });

    it("rejects non-test .rs files", () => {
      expect(detectTestFile("src/utils.rs", "rust")).toBe(false);
    });
  });

  describe("ruby", () => {
    it("detects _spec.rb files", () => {
      expect(detectTestFile("spec/user_spec.rb", "ruby")).toBe(true);
    });

    it("detects _test.rb files", () => {
      expect(detectTestFile("test/user_test.rb", "ruby")).toBe(true);
    });

    it("rejects non-test .rb files", () => {
      expect(detectTestFile("app/user.rb", "ruby")).toBe(false);
    });
  });

  describe("php", () => {
    it("detects Test.php files", () => {
      expect(detectTestFile("tests/UserTest.php", "php")).toBe(true);
    });

    it("rejects non-test .php files", () => {
      expect(detectTestFile("src/User.php", "php")).toBe(false);
    });
  });

  describe("c_sharp", () => {
    it("detects Tests.cs files", () => {
      expect(detectTestFile("Tests/UserTests.cs", "c_sharp")).toBe(true);
    });

    it("detects Test.cs files", () => {
      expect(detectTestFile("Tests/UserTest.cs", "c_sharp")).toBe(true);
    });

    it("rejects non-test .cs files", () => {
      expect(detectTestFile("src/User.cs", "c_sharp")).toBe(false);
    });
  });

  describe("cpp", () => {
    it("detects Test.cpp files", () => {
      expect(detectTestFile("tests/UserTest.cpp", "cpp")).toBe(true);
    });

    it("detects tests.cc files", () => {
      expect(detectTestFile("tests/user_tests.cc", "cpp")).toBe(true);
    });

    it("rejects non-test .cpp files", () => {
      expect(detectTestFile("src/user.cpp", "cpp")).toBe(false);
    });
  });

  describe("swift", () => {
    it("detects Tests.swift files", () => {
      expect(detectTestFile("Tests/UserTests.swift", "swift")).toBe(true);
    });

    it("rejects non-test .swift files", () => {
      expect(detectTestFile("Sources/User.swift", "swift")).toBe(false);
    });
  });

  describe("kotlin", () => {
    it("detects Test.kt files", () => {
      expect(detectTestFile("src/UserTest.kt", "kotlin")).toBe(true);
    });

    it("rejects non-test .kt files", () => {
      expect(detectTestFile("src/User.kt", "kotlin")).toBe(false);
    });
  });

  describe("dart", () => {
    it("detects _test.dart files", () => {
      expect(detectTestFile("test/user_test.dart", "dart")).toBe(true);
    });

    it("rejects non-test .dart files", () => {
      expect(detectTestFile("lib/user.dart", "dart")).toBe(false);
    });
  });

  describe("scala", () => {
    it("detects Spec.scala files", () => {
      expect(detectTestFile("test/UserSpec.scala", "scala")).toBe(true);
    });

    it("detects Test.scala files", () => {
      expect(detectTestFile("test/UserTest.scala", "scala")).toBe(true);
    });

    it("rejects non-test .scala files", () => {
      expect(detectTestFile("src/User.scala", "scala")).toBe(false);
    });
  });

  describe("clojure", () => {
    it("detects _test.clj files", () => {
      expect(detectTestFile("test/user_test.clj", "clojure")).toBe(true);
    });

    it("detects _test.cljs files", () => {
      expect(detectTestFile("test/user_test.cljs", "clojure")).toBe(true);
    });

    it("rejects non-test .clj files", () => {
      expect(detectTestFile("src/user.clj", "clojure")).toBe(false);
    });
  });

  describe("c", () => {
    it("detects Test.c files", () => {
      expect(detectTestFile("tests/UserTest.c", "c")).toBe(true);
    });

    it("rejects non-test .c files", () => {
      expect(detectTestFile("src/user.c", "c")).toBe(false);
    });
  });

  describe("unknown language", () => {
    it("returns false for unknown language", () => {
      expect(detectTestFile("test_file.xyz", "unknown_lang")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("matches on filename, not directory path", () => {
      expect(detectTestFile("test/helpers/factory.ts", "typescript")).toBe(false);
    });

    it("handles nested paths", () => {
      expect(detectTestFile("a/b/c/d/utils.test.ts", "typescript")).toBe(true);
    });

    it("handles bare filename without directory", () => {
      expect(detectTestFile("utils.test.ts", "typescript")).toBe(true);
    });
  });
});
