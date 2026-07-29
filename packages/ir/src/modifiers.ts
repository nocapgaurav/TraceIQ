import { Scope } from 'ts-morph';

import type { DeclarationModifiers, Visibility } from './types.js';

const NO_MODIFIERS: DeclarationModifiers = {
  isExported: false,
  isStatic: false,
  isAbstract: false,
  isReadonly: false,
  isOptional: false,
  isAsync: false,
};

/** Builds a full modifier set, defaulting everything not stated to `false`. */
export function modifiers(overrides: Partial<DeclarationModifiers> = {}): DeclarationModifiers {
  return { ...NO_MODIFIERS, ...overrides };
}

/**
 * Maps a member's scope to IR visibility.
 *
 * An ECMAScript private field reports scope `public`, because `#` is part of the
 * name rather than a modifier. It is private, so the name decides. Note that
 * `#value` and `private value` both report `private` here despite differing in
 * enforcement — the IR records visibility, not the mechanism.
 */
export function visibilityOf(scope: Scope, name: string): Visibility {
  if (name.startsWith('#')) {
    return 'private';
  }

  switch (scope) {
    case Scope.Private:
      return 'private';
    case Scope.Protected:
      return 'protected';
    default:
      return 'public';
  }
}
