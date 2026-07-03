export {
  catalogueFor,
  composeRubyCatalogue,
  enqueueEntrypoint,
  FULL_RUBY_CATALOGUE,
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
export { RAILS_RUNTIME_BUILTINS } from "./rails-runtime.js";
