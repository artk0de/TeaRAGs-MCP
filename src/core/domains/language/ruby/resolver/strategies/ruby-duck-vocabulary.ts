/** Ruby Object/Kernel/Enumerable methods that are never short-name resolvable
 *  to a meaningful in-project target. The DuckVocabularyNarrower uses this set
 *  to drop the entire fan-out when the call member belongs here (bd xlnub). */
export const RUBY_DUCK_VOCAB: ReadonlySet<string> = new Set([
  "to_s",
  "to_str",
  "inspect",
  "hash",
  "==",
  "eql?",
  "equal?",
  "freeze",
  "frozen?",
  "dup",
  "clone",
  "tap",
  "then",
  "itself",
  "each",
  "map",
  "to_a",
  "to_h",
  "to_proc",
  "call",
  "name",
  "class",
  "send",
]);
