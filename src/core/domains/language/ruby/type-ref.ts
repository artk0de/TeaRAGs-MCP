/**
 * Ruby's names for the kernel `TypeRef` algebra (`kernel/type-ref.ts`), kept as
 * a shim by E1 seam 2 so the four Ruby resolver / type-source modules, the
 * recall-forensics script and `tests/.../ruby/type-ref.test.ts` keep their
 * imports. The reasoning behind each function lives with the code in the
 * kernel; nothing Ruby-specific remains here.
 */
export {
  NIL_TYPE_REF as RUBY_NIL_TYPE_REF,
  typeRefEquals as rubyTypeRefEquals,
  typeRefNonNilArms as rubyNonNilArms,
  typeRefReceiverForm as rubyReceiverForm,
  typeRefUnionOf as rubyUnionOf,
} from "../kernel/type-ref.js";
