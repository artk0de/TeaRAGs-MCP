export {
  catalogueFor,
  composeRubyCatalogue,
  enqueueEntrypoint,
  FULL_RUBY_CATALOGUE,
  isCoreAmbiguousMember,
  isExternalBareCall,
  isExternalQualifiedMember,
  type RubyDslCatalogue,
  RUBY_DSL,
  RUBY_ENQUEUE_DISPATCH,
  RUBY_INSTANCE_RETURNING,
  RUBY_RELATION_RETURNING,
} from "./catalogue.js";
export { defineFrameworkVocabulary } from "./framework-module.js";
export type {
  DeclaredMethodSpec,
  DslCategory,
  DslOperandsShape,
  MethodKind,
  RubyDslEmits,
  RubyDslEntry,
  RubyFrameworkVocabulary,
} from "./types.js";
export { singularizeAssociation } from "./inflection.js";
export {
  ACTIVE_RECORD_COLUMN_VALUE_TYPES,
  ACTIVE_RECORD_QUERY_INTERFACE,
  ACTIVE_RECORD_SCHEMA_SNAPSHOT,
  columnAccessors,
  columnValueAccessor,
} from "./rails.js";
export { RAILS_RUNTIME_BUILTINS } from "./rails-runtime.js";
