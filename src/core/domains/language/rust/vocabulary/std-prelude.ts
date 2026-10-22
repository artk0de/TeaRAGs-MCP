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
  "Option",
  "Result",
]);

/** The primitive types — `str`, the integers, floats, `bool`, `char`; slices and arrays are read by shape. */
export const rustStdPrimitiveTypes: ReadonlySet<string> = new Set([
  "str",
  "bool",
  "char",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "f32",
  "f64",
]);

/**
 * The std smart pointers whose method resolution auto-derefs to their single
 * type argument: a receiver typed `Box<T>` is std's only when `T` is.
 */
export const rustStdSmartPointers: ReadonlySet<string> = new Set(["Box", "Rc", "Arc"]);

/**
 * The members `#[derive(..)]` generates — Default, Clone, Debug, PartialEq,
 * PartialOrd, Ord, Hash — plus the provided methods those traits carry. A
 * project type's call to one of them with no hand-written body anywhere in the
 * project lands in generated code (or std's provided body), never in-project.
 */
export const rustDerivableTraitMembers: ReadonlySet<string> = new Set([
  "default",
  "clone",
  "clone_from",
  "fmt",
  "eq",
  "ne",
  "partial_cmp",
  "lt",
  "le",
  "gt",
  "ge",
  "cmp",
  "max",
  "min",
  "clamp",
  "hash",
]);

/**
 * Std types whose `new(value)` takes the one value they wrap as their single
 * type argument: `Arc::new(x)` is `Arc<typeof x>`.
 */
export const rustStdValueWrappers: ReadonlySet<string> = new Set([
  "Box",
  "Rc",
  "Arc",
  "Cell",
  "RefCell",
  "Mutex",
  "RwLock",
]);

/** Prelude types `?` / `unwrap` / `expect` unwrap to their first type argument. */
export const rustStdUnwrappingTypes: ReadonlySet<string> = new Set(["Option", "Result"]);

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

/** A std-owned type spelling: a prelude type, a primitive, or a slice / array (`[u8]`, `[u8; 4]`). */
export function rustTextIsStdType(text: string): boolean {
  return rustStdPreludeTypes.has(text) || rustStdPrimitiveTypes.has(text) || text.startsWith("[");
}

export function rustTextIsStdSmartPointer(text: string): boolean {
  return rustStdSmartPointers.has(text);
}

export function rustTextIsDerivableTraitMember(text: string): boolean {
  return rustDerivableTraitMembers.has(text);
}

export function rustTextIsStdUnwrappingType(text: string): boolean {
  return rustStdUnwrappingTypes.has(text);
}

export function rustTextIsStdPreludeVariant(text: string): boolean {
  return rustStdPreludeVariants.has(text);
}

export function rustTextIsStdMacro(text: string): boolean {
  return rustStdMacros.has(text);
}

export function rustTextIsStdValueWrapper(text: string): boolean {
  return rustStdValueWrappers.has(text);
}
