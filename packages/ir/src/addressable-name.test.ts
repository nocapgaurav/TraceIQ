import { describe, expect, it } from 'vitest';

import { isAddressableName } from './addressable-name.js';

describe('isAddressableName', () => {
  it.each(['a', 'Service', '_internal', '$dollar', 'camelCase99', 'constructor', 'default'])(
    'accepts the plain identifier %s',
    (name) => {
      expect(isAddressableName(name)).toBe(true);
    },
  );

  it.each(['#secret', '#a1', '#_x'])('accepts the private name %s', (name) => {
    expect(isAddressableName(name)).toBe(true);
  });

  it.each([
    ['a destructuring pattern', '{ PORT, HOST }'],
    ['a computed name', '[Symbol.iterator]'],
    ['a string-literal member', "'content-type'"],
    ['a dotted name, which the chain separator claims', 'A.B'],
    ['an interior private marker', 'a#b'],
    ['a leading digit', '1abc'],
    ['an empty name', ''],
    ['whitespace', '   '],
    ['a hyphenated name', 'content-type'],
    ['a name with a space', 'two words'],
  ])('rejects %s', (_description, name) => {
    expect(isAddressableName(name)).toBe(false);
  });
});
