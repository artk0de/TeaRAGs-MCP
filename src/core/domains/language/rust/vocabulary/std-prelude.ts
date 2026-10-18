/**
 * The Rust standard-library surface the resolver classifies as external.
 * Data only — the predicates live beside the vocabulary's one consumer
 * (`resolver/strategies/rust-external-call.ts`), and a project namesake
 * vetoes every membership answer there, so a corpus that declares its own
 * `String` keeps its `String::new()` calls in the denominator.
 *
 * Conservative by design: a name missing here only costs an external call a
 * charged miss; a name present here hides a real miss — so everything listed
 * is reserved by std itself or spelled by the prelude, never merely common.
 */

/** Path heads `use` can spell that always name std, never a project crate. */
export const rustStdPathHeads: ReadonlySet<string> = new Set(["std", "core", "alloc", "proc_macro", "test"]);

/** Types the std prelude binds in every module without a `use`. */
export const rustStdPreludeTypes: ReadonlySet<string> = new Set([
  "String",
  "Vec",
  "VecDeque",
  "HashMap",
  "HashSet",
  "BTreeMap",
  "BTreeSet",
  "BinaryHeap",
  "LinkedList",
  "Box",
  "Rc",
  "Arc",
  "Cell",
  "RefCell",
  "Mutex",
  "RwLock",
  "Once",
  "Cow",
  "Path",
  "PathBuf",
  "Instant",
  "Duration",
  "SystemTime",
  "Ordering",
]);

/** Enum variant constructors the prelude binds: `Ok(())`, `Some(x)`, `Err(e)`. */
export const rustStdPreludeVariants: ReadonlySet<string> = new Set(["Ok", "Err", "Some", "None"]);

/** Macros the std prelude binds in every module without a `use`. */
export const rustStdMacros: ReadonlySet<string> = new Set([
  "vec",
  "format",
  "format_args",
  "print",
  "println",
  "eprint",
  "eprintln",
  "write",
  "writeln",
  "panic",
  "assert",
  "assert_eq",
  "assert_ne",
  "debug_assert",
  "debug_assert_eq",
  "todo",
  "unimplemented",
  "unreachable",
  "matches",
  "include_str",
  "include_bytes",
  "concat",
  "stringify",
  "env",
  "cfg",
  "compile_error",
  "thread_local",
]);

/** Traits the std prelude binds in every module without a `use`. */
export const rustStdTraits: ReadonlySet<string> = new Set([
  "Default",
  "Clone",
  "Copy",
  "Debug",
  "Display",
  "From",
  "Into",
  "FromStr",
  "FromIterator",
  "ToString",
  "Extend",
  "AsRef",
  "AsMut",
  "Borrow",
  "BorrowMut",
  "TryFrom",
  "TryInto",
  "ToOwned",
  "Ord",
  "PartialOrd",
  "Eq",
  "PartialEq",
  "Hash",
  "Send",
  "Sync",
  "Unpin",
  "Drop",
  "Deref",
  "DerefMut",
  "Index",
  "IndexMut",
  "Iterator",
  "IntoIterator",
  "ExactSizeIterator",
  "DoubleEndedIterator",
  "Fn",
  "FnMut",
  "FnOnce",
]);

export function rustTextIsStdPathHead(text: string): boolean {
  return rustStdPathHeads.has(text);
}

export function rustTextIsStdTrait(text: string): boolean {
  return rustStdTraits.has(text);
}

export function rustTextIsStdPreludeType(text: string): boolean {
  return rustStdPreludeTypes.has(text);
}

export function rustTextIsStdPreludeVariant(text: string): boolean {
  return rustStdPreludeVariants.has(text);
}

export function rustTextIsStdMacro(text: string): boolean {
  return rustStdMacros.has(text);
}
