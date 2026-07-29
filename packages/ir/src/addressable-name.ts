/**
 * Names the IR can address.
 *
 * A chain segment must survive into a `sym:` identifier, which admits a plain
 * identifier optionally prefixed by the ECMAScript private marker. Computed names
 * (`[Symbol.iterator]`), string-literal members (`'content-type'`) and
 * destructuring patterns (`{ PORT, HOST }`) have no stable representation in that
 * format, so declarations using them are skipped rather than mangled into one.
 */
const ADDRESSABLE_NAME = /^#?[A-Za-z_$][\w$]*$/;

export function isAddressableName(name: string): boolean {
  return ADDRESSABLE_NAME.test(name);
}
