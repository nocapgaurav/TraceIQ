import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run } from './cli.js';
import type { Io } from './types.js';

/**
 * The CLI end to end, over a real repository it scans itself.
 *
 * `run` is called as a function with an injected `Io`, so the whole CLI is exercised — parsing,
 * dispatch, the pipeline, every capability, rendering and exit statuses — without spawning a process
 * or touching the real terminal. These are the snapshot tests: they assert the shape and content of
 * what a user actually sees.
 *
 * The fixture is a small Express repository with two packages, a route chain, a member-expression
 * handler that cannot be linked, an environment variable, a mutual import cycle and recursion.
 */
const FILES = {
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { UserService } from '../../core/src/service';
const router = Router();
const service = new UserService();
const controller = { create() {} };
router.get('/users/:id', requireAuth, getUser);
router.post('/users', controller.create);
export function requireAuth(): void {}
export function getUser(): string | undefined { return service.find('1'); }
export default router;
`,
  'packages/core/src/service.ts': `import { helper } from './cycle.a';
export class UserService {
  find(id: string): string | undefined {
    helper();
    return process.env.JWT_SECRET;
  }
}
export function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }
`,
  'packages/core/src/cycle.a.ts': `import { partner } from './cycle.b';
export function helper(): number { return partner(); }
`,
  'packages/core/src/cycle.b.ts': `import { helper } from './cycle.a';
export function partner(): number { return helper(); }
`,
};

let root: string;
let database: string;

/** Captures what a command wrote, so a test reads exactly what a user would see. */
function capture(): Io & { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];

  return {
    out,
    err,
    cwd: root,
    write: (text) => {
      out.push(text);
    },
    writeError: (text) => {
      err.push(text);
    },
  };
}

async function invoke(...argv: string[]): Promise<{ status: number; out: string; err: string }> {
  const io = capture();
  const status = await run([...argv, `--db=${database}`], io);

  return { status, out: io.out.join(''), err: io.err.join('') };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'traceiq-cli-'));
  database = path.join(root, 'graph.db');

  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: false,
        skipLibCheck: true,
      },
    }),
    ...FILES,
  };

  for (const [relativePath, contents] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents, 'utf8');
  }

  const scan = await invoke('scan', root);

  expect(scan.status).toBe(0);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scan', () => {
  it('reports what it built', async () => {
    const { out, status } = await invoke('scan', root);

    expect(status).toBe(0);
    expect(out).toContain('files');
    expect(out).toContain('declarations');
    expect(out).toContain('call edges');
  });

  it('produces an identical summary on a second scan', async () => {
    const first = await invoke('scan', root);
    const second = await invoke('scan', root);

    expect(second.out).toBe(first.out);
  });
});

describe('overview', () => {
  it('reports the repository, the graph and health', async () => {
    const { out, status } = await invoke('overview');

    expect(status).toBe(0);
    expect(out).toContain('Repository');
    expect(out).toContain('Graph');
    expect(out).toContain('Health');
    expect(out).toContain('call graph coverage');
  });

  it('lists the derived packages', async () => {
    const { out } = await invoke('overview');

    expect(out).toContain('packages/api');
    expect(out).toContain('packages/core');
  });
});

describe('architecture, packages and package', () => {
  it('groups the architecture by role and kind', async () => {
    const { out } = await invoke('architecture');

    expect(out).toContain('Architecture');
    expect(out).toContain('Class');
    expect(out).toContain('Package dependencies');
  });

  it('lists packages with counts in both directions', async () => {
    const { out } = await invoke('packages');

    expect(out).toContain('dependents');
    expect(out).toContain('packages/core');
  });

  it('describes one package', async () => {
    const { out, status } = await invoke('package', 'packages/core');

    expect(status).toBe(0);
    expect(out).toContain('packages/core');
    expect(out).toContain('Files');
  });
});

describe('file and symbol', () => {
  it('browses a file by path, without an identity prefix', async () => {
    const { out, status } = await invoke('file', 'packages/core/src/service.ts');

    expect(status).toBe(0);
    expect(out).toContain('UserService');
    expect(out).toContain('Declarations');
  });

  it('browses the same file by identifier', async () => {
    const byPath = await invoke('file', 'packages/core/src/service.ts');
    const byId = await invoke('file', 'file:packages/core/src/service.ts');

    expect(byId.out).toBe(byPath.out);
  });

  it('explains a symbol with its callers, callees and health', async () => {
    const { out, status } = await invoke('symbol', 'sym:packages/core/src/service.ts#UserService.find');

    expect(status).toBe(0);
    expect(out).toContain('Callers');
    expect(out).toContain('Callees');
    expect(out).toContain('Impact');
    expect(out).toContain('Health');
    expect(out).toContain('Limitations');
  });

  it('reports the environment variable a symbol reads', async () => {
    const { out } = await invoke('symbol', 'sym:packages/core/src/service.ts#UserService.find');

    expect(out).toContain('JWT_SECRET');
  });
});

describe('impact', () => {
  it('separates DIRECT, INDIRECT and UNKNOWN', async () => {
    const { out, status } = await invoke('impact', 'sym:packages/core/src/cycle.a.ts#helper');

    expect(status).toBe(0);
    expect(out).toContain('DIRECT');
    expect(out).toContain('INDIRECT');
    expect(out).toContain('UNKNOWN');
  });
});

describe('routes and route', () => {
  it('lists the routes the fixture registers', async () => {
    const { out, status } = await invoke('routes');

    expect(status).toBe(0);
    expect(out).toContain('/users/:id');
    expect(out).toContain('/users');
  });

  it('explains a route chain in running order', async () => {
    const { out, status } = await invoke('route', 'GET', '/users/:id');

    expect(status).toBe(0);
    expect(out).toContain('Chain');
    expect(out).toContain('requireAuth');
    expect(out).toContain('getUser');
    expect(out).toContain('middleware');
  });

  it('states that the prefix could not be composed', async () => {
    const { out } = await invoke('route', 'GET', '/users/:id');

    expect(out).toContain('prefix composed');
    expect(out).toContain('false');
    expect(out).toContain('route-prefix-composition-unsupported');
  });

  it('reports a handler that could not be linked', async () => {
    const { out } = await invoke('route', 'POST', '/users');

    expect(out).toContain('Unlinked handlers');
    expect(out).toContain('controller.create');
  });

  it('reports the service the route reaches', async () => {
    const { out } = await invoke('route', 'GET', '/users/:id');

    expect(out).toContain('Reached');
    expect(out).toContain('UserService');
  });
});

describe('health, search, dependencies, cycles, hotspots', () => {
  it('reports health with metrics and findings', async () => {
    const { out, status } = await invoke('health');

    expect(status).toBe(0);
    expect(out).toContain('Metrics');
    expect(out).toContain('Findings');
    expect(out).toContain('graph density');
  });

  it('searches by prefix, alphabetically', async () => {
    const { out, status } = await invoke('search', 'help');

    expect(status).toBe(0);
    expect(out).toContain('helper');
  });

  it('reports no results plainly', async () => {
    const { out } = await invoke('search', 'zzzznothing');

    expect(out).toContain('(no results)');
  });

  it('navigates dependencies of a declaration', async () => {
    const { out, status } = await invoke('dependencies', 'sym:packages/core/src/cycle.a.ts#helper');

    expect(status).toBe(0);
    expect(out).toContain('DIRECT');
    expect(out).toContain('INDIRECT');
    expect(out).toContain('dependency closure');
  });

  it('navigates dependencies of a package named without a prefix', async () => {
    const { out, status } = await invoke('dependencies', 'packages/core');

    expect(status).toBe(0);
    expect(out).toContain('subject  package');
  });

  it('lists every cycle rather than counting them', async () => {
    const { out, status } = await invoke('cycles');

    expect(status).toBe(0);
    expect(out).toContain('Call cycles');
    expect(out).toContain('helper');
    expect(out).toContain('partner');
  });

  it('reports hotspots with a distribution', async () => {
    const { out, status } = await invoke('hotspots');

    expect(status).toBe(0);
    expect(out).toContain('Most referenced');
    expect(out).toContain('Distribution');
  });
});

describe('errors', () => {
  it('rejects an unknown command with status 2', async () => {
    const { status, err } = await invoke('nonsense');

    expect(status).toBe(2);
    expect(err).toContain('unknown-command');
  });

  it('rejects a missing argument with status 2', async () => {
    const { status, err } = await invoke('symbol');

    expect(status).toBe(2);
    expect(err).toContain('missing-argument');
    expect(err).toContain('usage: traceiq symbol <id>');
  });

  it('rejects an unknown option with status 2', async () => {
    const { status, err } = await invoke('overview', '--nope');

    expect(status).toBe(2);
    expect(err).toContain('unknown-option');
  });

  it('reports a missing graph with status 3', async () => {
    const io = capture();
    const status = await run(['overview', `--db=${path.join(root, 'absent.db')}`], io);

    expect(status).toBe(3);
    expect(io.err.join('')).toContain('repository-not-scanned');
  });

  it('reports an invalid repository with status 3', async () => {
    const { status, err } = await invoke('scan', path.join(root, 'nowhere'));

    expect(status).toBe(3);
    expect(err).toContain('invalid-repository');
  });

  it('reports an unknown identifier with status 4', async () => {
    const { status, err } = await invoke('symbol', 'sym:nowhere.ts#Absent');

    expect(status).toBe(4);
    expect(err).toContain('unknown-identifier');
  });

  it('reports an unknown route with status 4', async () => {
    const { status, err } = await invoke('route', 'GET', '/nowhere');

    expect(status).toBe(4);
    expect(err).toContain('unknown-route');
  });

  it('reports an unknown package with status 4', async () => {
    const { status, err } = await invoke('package', 'packages/nowhere');

    expect(status).toBe(4);
    expect(err).toContain('unknown-package');
  });

  it('writes an error to stderr and nothing to stdout', async () => {
    const io = capture();

    await run(['nonsense', `--db=${database}`], io);

    expect(io.out).toEqual([]);
    expect(io.err.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('produces identical output for every command run twice', async () => {
    for (const argv of [
      ['overview'],
      ['architecture'],
      ['packages'],
      ['package', 'packages/core'],
      ['file', 'packages/core/src/service.ts'],
      ['symbol', 'sym:packages/core/src/service.ts#UserService.find'],
      ['impact', 'sym:packages/core/src/cycle.a.ts#helper'],
      ['routes'],
      ['route', 'GET', '/users/:id'],
      ['health'],
      ['search', 'help'],
      ['dependencies', 'packages/core'],
      ['cycles'],
      ['hotspots'],
    ]) {
      const first = await invoke(...argv);
      const second = await invoke(...argv);

      expect(second.out, `command: ${argv.join(' ')}`).toBe(first.out);
      expect(second.status).toBe(first.status);
    }
  }, 60_000);

  it('writes plain ASCII with no colour or box drawing', async () => {
    const { out } = await invoke('overview');

    expect(out).toMatch(/^[\x20-\x7E\n]*$/);
  });

  it('carries no timing anywhere in an output', async () => {
    const { out } = await invoke('overview', '--profile');

    expect(out).toContain('Profile');
    expect(out).toContain('graph api calls');
    expect(out).not.toMatch(/\bms\b/);
  });

  it('carries no database path in a command that did not name one', async () => {
    const { out } = await invoke('cycles');

    expect(out).not.toContain(database);
  });
});

describe('reuse', () => {
  const readsOf = (out: string): number => Number(/graph api calls\s+(\d+)/.exec(out)?.[1] ?? '0');

  it('shares one graph read between the capabilities a command drives', async () => {
    // `symbol` drives Explain Symbol, Impact Analysis and Repository Health over one shared cache.
    // Run as three separate commands they each pay their own reads; together they pay once.
    const together = readsOf(
      (await invoke('symbol', 'sym:packages/core/src/service.ts#UserService.find', '--profile')).out,
    );
    const separately =
      readsOf((await invoke('impact', 'sym:packages/core/src/service.ts#UserService.find', '--profile')).out) +
      readsOf((await invoke('health', '--profile')).out);

    expect(together).toBeGreaterThan(0);
    expect(together).toBeLessThan(separately);
  });

  it('reports the reads a command made', async () => {
    const { out } = await invoke('overview', '--profile');

    expect(readsOf(out)).toBeGreaterThan(0);
  });

  it('opens no graph at all for a usage error', async () => {
    const { status, out } = await invoke('symbol');

    expect(status).toBe(2);
    expect(out).toBe('');
  });
});
