/**
 * Standard-library, Foundation, Dispatch and Concurrency TYPE names a Swift
 * receiver may be spelled as directly — `MainActor.run { … }`,
 * `JSONSerialization.data(withJSONObject:)`, `FileManager.default` (bd
 * tea-rags-mcp-y99pg.11).
 *
 * The resolver cannot tell an UpperCamelCase receiver the project does not
 * declare from a global VALUE it has no channel for (`let AF =
 * Session.default`), so it types such a receiver only when the name is on
 * this list. The list is consulted for the resolve-rate denominator alone —
 * never to resolve an edge — so a missing entry keeps a site in the
 * denominator and an entry the project also declares is ignored, because the
 * project's own declaration is checked first.
 */
export const SWIFT_SDK_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Array",
  "Bundle",
  "CharacterSet",
  "Data",
  "Date",
  "DateFormatter",
  "Dictionary",
  "DispatchQueue",
  "DispatchTime",
  "FileHandle",
  "FileManager",
  "HTTPCookieStorage",
  "HTTPURLResponse",
  "ISO8601DateFormatter",
  "JSONDecoder",
  "JSONEncoder",
  "JSONSerialization",
  "Locale",
  "MainActor",
  "NSLock",
  "NSRecursiveLock",
  "Notification",
  "NotificationCenter",
  "NumberFormatter",
  "OperationQueue",
  "ProcessInfo",
  "PropertyListDecoder",
  "PropertyListEncoder",
  "PropertyListSerialization",
  "RunLoop",
  "Set",
  "String",
  "Task",
  "Thread",
  "TimeZone",
  "URL",
  "URLCache",
  "URLComponents",
  "URLCredentialStorage",
  "URLQueryItem",
  "URLRequest",
  "URLSession",
  "URLSessionConfiguration",
  "UUID",
  "UserDefaults",
]);
