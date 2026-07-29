import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FrameworkFixture } from './framework-fixture.test-helper.js';

const FILES = {
  'src/config.ts': `export const PORT = process.env.PORT;
export const URL = process.env['DATABASE_URL'];
const key = 'RUNTIME';
export const COMPUTED = process.env[key];
export const WHOLE = { ...process.env };
export class Holder {
  secret = process.env.JWT_SECRET;
  read(): string | undefined {
    return process.env.NESTED;
  }
}
export function atFunctionLevel(): string | undefined {
  return process.env.IN_FUNCTION;
}
`,
  'src/shadowed.ts': `const process = { env: { FAKE: 'no' } };
export const value = process.env.FAKE;
`,
  'src/module-level.ts': `if (process.env.NODE_ENV === 'production') {
  // nothing
}
export const marker = 1;
`,
  'src/no-express.ts': `export const plain = 1;
`,
};

let fixture: FrameworkFixture;

beforeAll(async () => {
  fixture = await FrameworkFixture.create(FILES);
});

afterAll(async () => {
  await fixture.remove();
});

const usage = (name: string) =>
  fixture.annotations.environmentVariables.find((entry) => entry.name === name);

describe('environment reads', () => {
  it('reads a property access', () => {
    expect(usage('PORT')).toBeDefined();
  });

  it('reads a string-literal element access the same way', () => {
    expect(usage('DATABASE_URL')).toBeDefined();
  });

  it('reads one inside a class property initializer', () => {
    expect(usage('JWT_SECRET')).toBeDefined();
  });

  it('reads one inside a method body', () => {
    expect(usage('NESTED')).toBeDefined();
  });

  it('reads one inside a function body', () => {
    expect(usage('IN_FUNCTION')).toBeDefined();
  });

  it('reads one at module level', () => {
    expect(usage('NODE_ENV')).toBeDefined();
  });
});

describe('attribution', () => {
  it('attributes a read to the variable it initialises', () => {
    expect(usage('PORT')?.usedInDeclarationId).toBe('sym:src/config.ts#PORT');
  });

  it('attributes a read to the property it initialises', () => {
    expect(usage('JWT_SECRET')?.usedInDeclarationId).toBe('sym:src/config.ts#Holder.secret');
  });

  it('attributes a read to the method containing it', () => {
    expect(usage('NESTED')?.usedInDeclarationId).toBe('sym:src/config.ts#Holder.read');
  });

  it('attributes a read to the function containing it', () => {
    expect(usage('IN_FUNCTION')?.usedInDeclarationId).toBe('sym:src/config.ts#atFunctionLevel');
  });

  it('attributes a module-level read to no declaration', () => {
    expect(usage('NODE_ENV')?.usedInDeclarationId).toBeNull();
  });
});

describe('what is not read', () => {
  it('does not guess at a computed key', () => {
    // `process.env[key]` names no variable, and reporting `process.env` would claim a
    // different read from the one written.
    expect(fixture.envNames()).not.toContain('RUNTIME');
    expect(fixture.envNames()).not.toContain('key');
  });

  it('does not invent a name for a whole-object read', () => {
    // `{ ...process.env }` reads the object, not a variable.
    expect(fixture.annotations.environmentVariables.every((entry) => entry.name.length > 0)).toBe(true);
  });
});

describe('a shadowed root', () => {
  it('still reports the read rather than dropping it', () => {
    expect(usage('FAKE')).toBeDefined();
  });

  it('says in the evidence that the root may be shadowed', () => {
    expect(usage('FAKE')?.provenance.evidence).toMatch(/may be shadowed/);
  });

  it('says the opposite where nothing shadows it', () => {
    expect(usage('PORT')?.provenance.evidence).toMatch(/nothing in this file declares or imports/);
  });
});

describe('the environment contract', () => {
  it('records every read as INFERRED, this package having no resolver', () => {
    expect(
      fixture.annotations.environmentVariables.every((entry) => entry.confidence === 'INFERRED'),
    ).toBe(true);
  });

  it('explains and locates every read', () => {
    for (const entry of fixture.annotations.environmentVariables) {
      expect(entry.provenance.annotator).toBe('environment');
      expect(entry.provenance.evidence).toContain('environment variable');
      expect(entry.location.startLine).toBeGreaterThan(0);
    }
  });

  it('extracts reads even where Express is absent', () => {
    // Environment usage has nothing to do with Express.
    expect(fixture.annotations.framework).toBeNull();
    expect(fixture.annotations.environmentVariables.length).toBeGreaterThan(0);
  });

  it('produces no routes when Express is absent', () => {
    expect(fixture.annotations.routes).toEqual([]);
  });

  it('produces identical reads from identical inputs', () => {
    expect(fixture.reextract().environmentVariables).toEqual(fixture.annotations.environmentVariables);
  });
});
