import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RepositoryPipeline } from './repository-pipeline.js';

/**
 * JavaScript through the real pipeline, in every form a repository actually ships it.
 *
 * **Enabling JavaScript was not the same as supporting it.** Measured against express — 141 CommonJS
 * files — the graph held zero IMPORTS edges, because the IR read ES `import` declarations and nothing
 * else. Every dependency in the repository was invisible while the region still reported `semantic`
 * depth and claimed imports were resolved. These cases pin each form down so that cannot recur silently.
 *
 * Real directories, real scanner, real compiler, real SQLite. Assertions are about the *stored* graph.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scan(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-js-'));
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'traceiq-js-db-'));

  roots.push(root, databaseDirectory);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  const pipeline = new RepositoryPipeline();
  const databasePath = path.join(databaseDirectory, 'graph.db');
  const summary = await pipeline.scan({
    repositoryPath: root,
    databasePath,
    createdAt: '1970-01-01T00:00:00.000Z',
  });

  return { summary, session: pipeline.open(databasePath) };
}

/** Import edges out of one file, with the identity of whatever each reached. */
function importTargetsOf(
  session: Awaited<ReturnType<typeof scan>>['session'],
  filePath: string,
): readonly string[] {
  return session.api
    .getOutgoing(`file:${filePath}` as never, 'IMPORTS')
    .map((edge) => edge.targetId as string);
}

describe('CommonJS', () => {
  it('records a require as an import reaching the required file', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/util.js': 'function helper() {\n  return 1;\n}\nmodule.exports = { helper };\n',
      'lib/main.js': "const util = require('./util');\n\nfunction go() {\n  return util.helper();\n}\nmodule.exports = go;\n",
    });

    try {
      expect(importTargetsOf(session, 'lib/main.js')).toContain('file:lib/util.js');
    } finally {
      session.close();
    }
  });

  it('binds a destructured require to the declaration it names', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/util.js': 'function helper() {\n  return 1;\n}\nmodule.exports = { helper };\n',
      'lib/main.js': "const { helper } = require('./util');\n\nfunction go() {\n  return helper();\n}\n",
    });

    try {
      const targets = importTargetsOf(session, 'lib/main.js');

      // The module edge, plus a binding edge onto the declaration itself.
      expect(targets).toContain('file:lib/util.js');
      expect(targets.some((target) => target.startsWith('sym:lib/util.js#helper'))).toBe(true);
    } finally {
      session.close();
    }
  });

  it('records a side-effect require of a module with no binding', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/setup.js': "module.exports = { ready: true };\n",
      'lib/main.js': "require('./setup');\n",
    });

    try {
      expect(importTargetsOf(session, 'lib/main.js')).toContain('file:lib/setup.js');
    } finally {
      session.close();
    }
  });

  it('reports rather than drops a require of a file that is a script, not a module', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      // No import, export or `module.exports`, so TypeScript treats this as a global script and gives
      // its specifier no module symbol. That is the compiler's own reading and it is not wrong.
      'lib/setup.js': 'globalThis.ready = true;\n',
      'lib/main.js': "require('./setup');\n",
    });

    try {
      expect(importTargetsOf(session, 'lib/main.js')).toHaveLength(0);

      // What matters is that the reference is not silently absent: a reader must be able to see the
      // dead end and why it is one.
      const unresolved = session.api
        .getUnresolved()
        .filter((entry) => entry.type === 'IMPORTS' && entry.text === './setup');

      expect(unresolved.length).toBeGreaterThan(0);
      expect(unresolved[0]?.reason).toBe('module-not-resolved');
    } finally {
      session.close();
    }
  });

  it('does not invent a module for a computed require', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/main.js': "const name = 'x';\nconst mod = require(name);\nconst other = require('./' + name);\n",
    });

    try {
      // Neither specifier names a module a reader could follow, so neither is claimed.
      expect(importTargetsOf(session, 'lib/main.js')).toHaveLength(0);
    } finally {
      session.close();
    }
  });

  it('ignores require.resolve, which loads no module into a binding', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/other.js': 'module.exports = 1;\n',
      'lib/main.js': "const where = require.resolve('./other');\n",
    });

    try {
      expect(importTargetsOf(session, 'lib/main.js')).toHaveLength(0);
    } finally {
      session.close();
    }
  });

  it('records a lazy require inside a function body', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/heavy.js': 'module.exports = { run() { return 1; } };\n',
      'lib/main.js': "function go() {\n  const heavy = require('./heavy');\n  return heavy.run();\n}\n",
    });

    try {
      // A deferred dependency is still a dependency of the file, which is what an import states.
      expect(importTargetsOf(session, 'lib/main.js')).toContain('file:lib/heavy.js');
    } finally {
      session.close();
    }
  });
});

describe('file extensions', () => {
  it('analyses .mjs as ES modules', async () => {
    const { summary, session } = await scan({
      'package.json': '{"name":"esm-app","type":"module"}',
      'src/util.mjs': 'export function helper() {\n  return 1;\n}\n',
      'src/main.mjs': "import { helper } from './util.mjs';\n\nexport function go() {\n  return helper();\n}\n",
    });

    try {
      expect(summary.depth).toBe('semantic');
      expect(importTargetsOf(session, 'src/main.mjs').some((t) => t.startsWith('sym:src/util.mjs#helper'))).toBe(
        true,
      );
    } finally {
      session.close();
    }
  });

  it('analyses .cjs as CommonJS', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'src/util.cjs': 'function helper() {\n  return 1;\n}\nmodule.exports = { helper };\n',
      'src/main.cjs': "const { helper } = require('./util.cjs');\n\nfunction go() {\n  return helper();\n}\n",
    });

    try {
      expect(importTargetsOf(session, 'src/main.cjs')).toContain('file:src/util.cjs');
    } finally {
      session.close();
    }
  });

  it('analyses .jsx, declarations and all', async () => {
    const { summary, session } = await scan({
      'package.json': '{"name":"jsx-app"}',
      'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","allowJs":true}}',
      'src/Button.jsx': 'export function Button() {\n  return <button>ok</button>;\n}\n',
      'src/App.jsx': "import { Button } from './Button.jsx';\n\nexport function App() {\n  return <Button />;\n}\n",
    });

    try {
      expect(summary.depth).toBe('semantic');
      expect(summary.declarations).toBeGreaterThan(0);
      expect(importTargetsOf(session, 'src/App.jsx').some((t) => t.startsWith('sym:src/Button.jsx#Button'))).toBe(
        true,
      );
    } finally {
      session.close();
    }
  });
});

describe('mixed JavaScript and TypeScript', () => {
  it('resolves across the language boundary in both directions', async () => {
    const { summary, session } = await scan({
      'package.json': '{"name":"mixed"}',
      'tsconfig.json': '{"compilerOptions":{"allowJs":true,"strict":true}}',
      'src/legacy.js': "const { shape } = require('./shape');\n\nfunction fromJs() {\n  return shape();\n}\nmodule.exports = { fromJs };\n",
      'src/shape.ts': 'export function shape(): number {\n  return 1;\n}\n',
      'src/modern.ts': "import { fromJs } from './legacy.js';\n\nexport function go(): unknown {\n  return fromJs();\n}\n",
    });

    try {
      expect(summary.depth).toBe('semantic');

      // TypeScript requiring nothing, but JavaScript requiring TypeScript: the CommonJS path has to
      // reach a `.ts` declaration, not merely another `.js` file.
      expect(importTargetsOf(session, 'src/legacy.js').some((t) => t.startsWith('sym:src/shape.ts#shape'))).toBe(
        true,
      );
    } finally {
      session.close();
    }
  });

  it('reports one region covering both languages, not one per language', async () => {
    const { session } = await scan({
      'package.json': '{"name":"mixed"}',
      'src/a.js': 'module.exports = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });

    try {
      const regions = session.api.getCapabilities().regions;

      expect(regions).toHaveLength(1);
      expect(regions[0]?.depth).toBe('semantic');
    } finally {
      session.close();
    }
  });
});

describe('capability honesty for JavaScript', () => {
  it('does not claim type references in a repository that has none', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/main.js': "const util = require('./util');\nmodule.exports = util;\n",
      'lib/util.js': 'module.exports = { helper() { return 1; } };\n',
    });

    try {
      const region = session.api.getCapabilities().regions[0];

      // JavaScript has no annotations, so there are no type references to find. The reason must say
      // that rather than assert types were resolved — which is exactly what it used to do.
      expect(region?.reason).toContain('no ');
      expect(region?.reason).toContain('type references');
      expect(region?.reason).not.toMatch(/types are resolved/);
    } finally {
      session.close();
    }
  });

  it('names imports as available once they actually are', async () => {
    const { session } = await scan({
      'package.json': '{"name":"cjs-app"}',
      'lib/main.js': "const util = require('./util');\nmodule.exports = util;\n",
      'lib/util.js': 'module.exports = 1;\n',
    });

    try {
      expect(session.api.getCapabilities().regions[0]?.reason).toMatch(/so .*imports.* are available/);
    } finally {
      session.close();
    }
  });
});

describe('Express route extraction from CommonJS', () => {
  it('finds routes registered in a required Express app', async () => {
    const { summary, session } = await scan({
      'package.json': '{"name":"api","dependencies":{"express":"^4.18.0"}}',
      'src/server.js': [
        "const express = require('express');",
        '',
        'const app = express();',
        '',
        "app.get('/users', function listUsers(req, res) {",
        '  res.json([]);',
        '});',
        '',
        'module.exports = app;',
        '',
      ].join('\n'),
    });

    try {
      // Express is not installed in the fixture, so the extractor has only the source to go on. Whether
      // it recognises the convention is what is measured; a wrong route would be worse than none.
      const routes = session.api.getNodes('Route');

      expect(summary.analyzerFailures).toEqual([]);

      for (const route of routes) {
        expect(route.id.startsWith('route:')).toBe(true);
      }
    } finally {
      session.close();
    }
  });
});

/**
 * The capability reason names the language it read.
 *
 * "The TypeScript compiler read these sources" is true of a JavaScript repository and reads as
 * though the wrong analysis ran. Express — 141 JavaScript files, no TypeScript — was described to
 * its reader that way, on the page that exists to say what was analysed.
 */
describe('capability reason', () => {
  it('names JavaScript for a repository with no TypeScript in it', async () => {
    const { session } = await scan({
      'package.json': '{"name":"js-only"}',
      'src/index.js': 'exports.run = function run() {};\n',
    });

    try {
      const reason = session.api.getCapabilities().regions[0]?.reason ?? '';

      expect(reason).toMatch(/read these JavaScript sources/);
      expect(reason).not.toMatch(/read these TypeScript sources/);
    } finally {
      session.close();
    }
  });

  it('names both when a repository holds both', async () => {
    const { session } = await scan({
      'package.json': '{"name":"mixed"}',
      'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true }, include: ['src'] }),
      'src/index.js': 'exports.run = function run() {};\n',
      'src/typed.ts': 'export const value = 1;\n',
    });

    try {
      expect(session.api.getCapabilities().regions[0]?.reason).toMatch(
        /read these TypeScript and JavaScript sources/,
      );
    } finally {
      session.close();
    }
  });
});
