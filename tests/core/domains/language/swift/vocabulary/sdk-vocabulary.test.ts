/**
 * The generated Swift SDK substrate, read through its one reader. These pin
 * facts of the real artifact — the shapes resolution depends on — so a
 * regeneration that loses one fails here rather than as a quiet rate drop.
 */

import { describe, expect, it } from "vitest";

import { SWIFT_SDK_VOCABULARY_JSON } from "../../../../../../src/core/domains/language/swift/vocabulary/sdk-vocabulary.generated.js";
import { swiftSdkVocabulary } from "../../../../../../src/core/domains/language/swift/vocabulary/sdk-vocabulary.js";
import { parseSwiftTypeText } from "../../../../../../src/core/domains/language/swift/vocabulary/swift-type-text.js";

const sdk = swiftSdkVocabulary();

describe("SwiftSdkVocabulary", () => {
  it("is one shared instance", () => {
    expect(swiftSdkVocabulary()).toBe(sdk);
  });

  it("knows SDK types across the standard library, Foundation, Dispatch and Combine", () => {
    for (const name of ["Array", "Result", "Data", "OutputStream", "DispatchQueue", "AnyPublisher", "XCTestCase"]) {
      expect(sdk.hasType(name), name).toBe(true);
    }
    expect(sdk.hasType("Session")).toBe(false);
  });

  // bd tea-rags-mcp-y99pg.39 — SwiftUI re-exports its core from SwiftUICore
  // (macOS 15 / iOS 18 SDKs on), whose symbol graph is its own.
  it("knows SwiftUI's core view types, which live in SwiftUICore", () => {
    expect(sdk.type("View")?.kind).toBe("protocol");
    for (const name of ["Text", "Color", "VStack", "Rectangle"]) expect(sdk.hasType(name), name).toBe(true);
    expect(sdk.supertypes("Text")).toContain("View");
    expect(sdk.findMember("Text", "frame")?.owner.path).toBe("View");
  });

  // bd tea-rags-mcp-agapr — the macOS app frameworks a real menu-bar app
  // imports: AppKit, AVFAudio, UserNotifications, CryptoKit,
  // ServiceManagement, Intents.
  it("knows the macOS app frameworks' types and their members", () => {
    for (const name of [
      "NSView",
      "NSCursor",
      "AVAudioPlayer",
      "UNUserNotificationCenter",
      "SHA256",
      "SMAppService",
      "INFocusStatusCenter",
    ]) {
      expect(sdk.hasType(name), name).toBe(true);
    }
    expect(sdk.findMember("NSCursor", "arrow")?.members[0]).toMatchObject({ isStatic: true });
    expect(sdk.findMember("AVAudioPlayer", "play")).toBeDefined();
    expect(sdk.findMember("SMAppService", "register")).toBeDefined();
    expect(sdk.findMember("UNUserNotificationCenter", "current")?.members[0].returns).toBe("UNUserNotificationCenter");
  });

  it("reaches an inherited member through the superclass chain", () => {
    expect(sdk.type("OutputStream")?.superclass).toBe("Stream");
    expect(sdk.findMember("OutputStream", "close")?.owner.path).toBe("Stream");
  });

  it("reaches a protocol extension member through the conformances", () => {
    expect(sdk.supertypes("Array")).toContain("Collection");
    expect(sdk.supertypes("Array")).toContain("Sequence");
    expect(sdk.findMember("Set", "forEach")?.owner.path).toBe("Sequence");
  });

  it("publishes return types, closure parameters and generic constraints", () => {
    const mapError = sdk.findMember("Result", "mapError");
    expect(mapError?.members[0].returns).toBe("Result<Success, NewFailure>");
    expect(mapError?.members[0].closureParameters).toEqual(["(Failure) -> NewFailure"]);
    expect(sdk.type("Result")?.genericConstraints).toMatchObject({ Failure: "Error" });
    expect(sdk.findMember("Result", "get")?.members[0].returns).toBe("Success");
  });

  it("publishes static properties and member type aliases", () => {
    const preferred = sdk.findMember("Locale", "preferredLanguages")?.members[0];
    expect(preferred).toMatchObject({ kind: "property", isStatic: true, returns: "[String]" });
    expect(sdk.findAlias("Array", "SubSequence")?.text).toBe("ArraySlice<Element>");
  });

  it("publishes the closure a module-level SDK function takes (bd tea-rags-mcp-y99pg.29)", () => {
    const shapes = sdk.globalFunctions("withCheckedContinuation");
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.every((shape) => shape.closureParameters.at(-1) === "(CheckedContinuation<T, Never>) -> Void")).toBe(
      true,
    );
    // The typed-throws overload spells its failure as the function's own `E: Error`.
    const throwing = sdk.globalFunctions("withCheckedThrowingContinuation");
    expect(throwing.length).toBeGreaterThan(1);
    for (const shape of throwing) {
      expect(shape.closureParameters.at(-1)).toMatch(/^\(CheckedContinuation<T, (any Error|E)>\) -> Void$/);
    }
    expect(sdk.globalFunctions("noSuchFunction")).toEqual([]);
  });

  it("spells every declared and returned type in a grammar the parser covers", () => {
    const raw = JSON.parse(SWIFT_SDK_VOCABULARY_JSON) as {
      types: Record<string, { m: Record<string, string[]> }>;
    };
    let total = 0;
    let parsed = 0;
    for (const [path, type] of Object.entries(raw.types)) {
      for (const name of Object.keys(type.m)) {
        for (const member of sdk.ownMembers(path, name)) {
          if (member.returns === null) continue;
          total++;
          if (parseSwiftTypeText(member.returns) !== undefined) parsed++;
        }
      }
    }
    expect(total).toBeGreaterThan(10_000);
    expect(parsed / total).toBeGreaterThan(0.99);
  });
});
