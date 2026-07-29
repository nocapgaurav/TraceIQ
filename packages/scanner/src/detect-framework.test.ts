import { describe, expect, it } from 'vitest';

import { detectFramework } from './detect-framework.js';

describe('detectFramework', () => {
  it('reports Express when it is a declared dependency', () => {
    expect(detectFramework(['express', 'zod'])).toBe('express');
  });

  it('reports unknown when Express is absent', () => {
    expect(detectFramework(['fastify', 'zod'])).toBe('unknown');
  });

  it('reports unknown for a repository with no dependencies', () => {
    expect(detectFramework([])).toBe('unknown');
  });

  it('does not match a package that merely mentions Express', () => {
    expect(detectFramework(['express-rate-limit', '@types/express'])).toBe('unknown');
  });
});
