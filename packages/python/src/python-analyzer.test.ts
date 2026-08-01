import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RepositoryScanner, type RepositoryInventory } from '@traceiq/scanner';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PythonAnalyzer, preloadPythonParser } from './python-analyzer.js';

const roots: string[] = [];

beforeAll(async () => {
  await preloadPythonParser();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inventoryOf(files: Readonly<Record<string, string>>): Promise<RepositoryInventory> {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-python-'));

  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  return new RepositoryScanner().scan(root);
}

async function analyze(files: Readonly<Record<string, string>>) {
  const inventory = await inventoryOf(files);
  const analyzer = await PythonAnalyzer.prepare(inventory);

  return analyzer.analyze({ inventory });
}

const declarationNames = (outcome: Awaited<ReturnType<typeof analyze>>) =>
  (outcome.contribution?.ir.declarations ?? []).map((entry) => entry.containerChain.join('.'));

describe('declarations', () => {
  it('records functions, async functions, classes, methods and module variables', async () => {
    const outcome = await analyze({
      'app.py': `TIMEOUT = 30

def plain():
    pass

async def fetched():
    pass

class Service:
    LIMIT = 10

    def run(self):
        pass
`,
    });

    expect(declarationNames(outcome)).toEqual(
      expect.arrayContaining(['TIMEOUT', 'plain', 'fetched', 'Service', 'Service.LIMIT', 'Service.run']),
    );
  });

  it('marks an async function async and a plain one not', async () => {
    const outcome = await analyze({ 'app.py': 'async def a():\n    pass\n\ndef b():\n    pass\n' });
    const byName = new Map(
      (outcome.contribution?.ir.declarations ?? []).map((entry) => [entry.name, entry]),
    );

    expect(byName.get('a')?.modifiers.isAsync).toBe(true);
    expect(byName.get('b')?.modifiers.isAsync).toBe(false);
  });

  it('calls a def inside a class a method and one outside it a function', async () => {
    const outcome = await analyze({ 'app.py': 'class S:\n    def m(self):\n        pass\n\ndef f():\n    pass\n' });
    const byChain = new Map(
      (outcome.contribution?.ir.declarations ?? []).map((entry) => [
        entry.containerChain.join('.'),
        entry.kind,
      ]),
    );

    expect(byChain.get('S.m')).toBe('method');
    expect(byChain.get('f')).toBe('function');
  });

  it('does not record locals inside a function body', async () => {
    const outcome = await analyze({ 'app.py': 'def f():\n    local = 1\n    return local\n' });

    expect(declarationNames(outcome)).not.toContain('f.local');
  });

  it('emits no exports, Python having no export statement', async () => {
    // Emitting one would invent a construct the language does not have, purely for symmetry.
    const outcome = await analyze({ 'app.py': 'def f():\n    pass\n' });

    expect(outcome.contribution?.ir.exports).toEqual([]);
  });
});

describe('imports and module resolution', () => {
  it('resolves a relative from-import to the module and the declaration', async () => {
    const outcome = await analyze({
      'pkg/__init__.py': '',
      'pkg/models.py': 'class User:\n    pass\n',
      'pkg/service.py': 'from .models import User\n',
    });

    const relationships = outcome.contribution?.resolved.relationships ?? [];

    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'IMPORTS', target: { kind: 'file', fileId: 'file:pkg/models.py' } }),
        expect.objectContaining({
          type: 'IMPORTS',
          name: 'User',
          target: { kind: 'declaration', declarationId: 'sym:pkg/models.py#User' },
        }),
      ]),
    );
  });

  it('treats a src layout as an import root', async () => {
    // `src/app/main.py` is the module `app.main`, which is the point of the layout.
    const outcome = await analyze({
      'src/app/__init__.py': '',
      'src/app/models.py': 'class User:\n    pass\n',
      'src/app/main.py': 'from app.models import User\n',
    });

    expect(outcome.contribution?.resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'IMPORTS',
          name: 'User',
          target: { kind: 'declaration', declarationId: 'sym:src/app/models.py#User' },
        }),
      ]),
    );
  });

  it('resolves a parent-relative import', async () => {
    const outcome = await analyze({
      'pkg/__init__.py': '',
      'pkg/models.py': 'class User:\n    pass\n',
      'pkg/api/__init__.py': '',
      'pkg/api/routes.py': 'from ..models import User\n',
    });

    expect(outcome.contribution?.resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'IMPORTS',
          target: { kind: 'file', fileId: 'file:pkg/models.py' },
        }),
      ]),
    );
  });

  it('resolves a third-party import to a named external in the Python ecosystem', async () => {
    // Was reported unresolved, which meant a Python reader could see the dependencies a manifest
    // declared and never the ones a file actually imported. The name is the module as written, not a
    // distribution name — nothing here reads installed metadata.
    const outcome = await analyze({ 'app.py': 'from fastapi import FastAPI\n' });

    expect(outcome.contribution?.resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'IMPORTS',
          target: { kind: 'external', origin: 'package', name: 'fastapi', ecosystem: 'python' },
          // Never RESOLVED: site-packages was not read, so this is what the name says.
          confidence: 'INFERRED',
        }),
      ]),
    );
  });

  it('separates a standard-library import from an installed distribution', async () => {
    const outcome = await analyze({ 'app.py': 'import os\nimport fastapi\n' });
    const targets = (outcome.contribution?.resolved.relationships ?? [])
      .filter((relationship) => relationship.type === 'IMPORTS')
      .map((relationship) => relationship.target);

    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: 'external', origin: 'standard-library', name: 'os', ecosystem: 'python' },
        { kind: 'external', origin: 'package', name: 'fastapi', ecosystem: 'python' },
      ]),
    );
  });

  it('records an alias under the name the importing module binds', async () => {
    const outcome = await analyze({
      'models.py': 'class User:\n    pass\n',
      'app.py': 'from models import User as Account\n',
    });

    expect(outcome.contribution?.resolved.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'IMPORTS', name: 'Account' })]),
    );
  });

  it('binds no names for a wildcard import rather than guessing them', async () => {
    const outcome = await analyze({
      'models.py': 'class User:\n    pass\n',
      'app.py': 'from models import *\n',
    });

    const named = (outcome.contribution?.resolved.relationships ?? []).filter(
      (entry) => entry.type === 'IMPORTS' && entry.name !== null,
    );

    expect(named).toEqual([]);
  });
});

describe('inheritance', () => {
  it('resolves a base class across modules', async () => {
    const outcome = await analyze({
      'base.py': 'class Base:\n    pass\n',
      'user.py': 'from base import Base\n\nclass User(Base):\n    pass\n',
    });

    expect(outcome.contribution?.resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'EXTENDS',
          confidence: 'RESOLVED',
          target: { kind: 'declaration', declarationId: 'sym:base.py#Base' },
        }),
      ]),
    );
  });

  it('ignores a metaclass keyword argument, which is not a base', async () => {
    const outcome = await analyze({ 'app.py': 'class S(metaclass=type):\n    pass\n' });

    expect(outcome.contribution?.resolved.relationships.filter((r) => r.type === 'EXTENDS')).toEqual([]);
  });
});

describe('calls', () => {
  it('binds a call to a module-level function', async () => {
    const outcome = await analyze({ 'app.py': 'def helper():\n    pass\n\ndef go():\n    return helper()\n' });

    expect(outcome.contribution?.callGraph.calls).toEqual([
      expect.objectContaining({ calleeText: 'helper', targetId: 'sym:app.py#helper' }),
    ]);
  });

  it('binds self.method to the enclosing class', async () => {
    const outcome = await analyze({
      'app.py': 'class S:\n    def a(self):\n        pass\n\n    def b(self):\n        return self.a()\n',
    });

    expect(outcome.contribution?.callGraph.calls).toEqual([
      expect.objectContaining({ calleeText: 'self.a', targetId: 'sym:app.py#S.a' }),
    ]);
  });

  it('binds self.method to an inherited member through resolved bases', async () => {
    const outcome = await analyze({
      'app.py': 'class Base:\n    def save(self):\n        pass\n\nclass User(Base):\n    def rename(self):\n        return self.save()\n',
    });

    expect(outcome.contribution?.callGraph.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calleeText: 'self.save', targetId: 'sym:app.py#Base.save' }),
      ]),
    );
  });

  it('marks every call INFERRED, never RESOLVED', async () => {
    // Python binds names at runtime. Claiming RESOLVED would put a Python edge on the same footing
    // as one a type checker proved, which no static reading of Python earns.
    const outcome = await analyze({ 'app.py': 'def a():\n    pass\n\ndef b():\n    return a()\n' });

    for (const call of outcome.contribution?.callGraph.calls ?? []) {
      expect(call.confidence).toBe('INFERRED');
    }
  });

  it('refuses to bind an attribute call on an untyped receiver', async () => {
    // `svc.run()` needs the runtime type of `svc`. Guessing the only `run` in the repository would
    // be wrong as often as right.
    const outcome = await analyze({
      'app.py': 'class S:\n    def run(self):\n        pass\n\nsvc = make()\n\ndef go():\n    return svc.run()\n',
    });

    expect(outcome.contribution?.callGraph.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calleeText: 'svc.run', reason: 'root-type-unknown' }),
      ]),
    );
  });

  it('records a nested call once, not twice', async () => {
    const outcome = await analyze({
      'app.py': 'class S:\n    def create(self):\n        pass\n\ndef go():\n    return S().create()\n',
    });

    const all = [
      ...(outcome.contribution?.callGraph.calls ?? []).map((c) => c.calleeText),
      ...(outcome.contribution?.callGraph.unresolved ?? []).map((c) => c.calleeText),
    ];

    expect(all.filter((text) => text === 'S')).toHaveLength(1);
  });
});

describe('adversarial input', () => {
  it('recovers declarations from a module with a syntax error', async () => {
    // tree-sitter's error recovery is why a malformed file degrades instead of failing the region.
    const outcome = await analyze({ 'app.py': 'def good():\n    pass\n\ndef broken(:\n    pass\n' });

    expect(declarationNames(outcome)).toContain('good');
    expect(outcome.failure).toBeNull();
  });

  it('handles a module with unicode identifiers and paths', async () => {
    const outcome = await analyze({ 'paquete/módulo.py': 'def función():\n    pass\n' });

    expect(declarationNames(outcome)).toContain('función');
  });

  it('tolerates duplicate names across modules without collapsing them', async () => {
    const outcome = await analyze({
      'a.py': 'def run():\n    pass\n',
      'b.py': 'def run():\n    pass\n',
    });

    const ids = (outcome.contribution?.ir.declarations ?? []).map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not hang on a cyclic import', async () => {
    const outcome = await analyze({
      'a.py': 'from b import beta\n\ndef alpha():\n    pass\n',
      'b.py': 'from a import alpha\n\ndef beta():\n    pass\n',
    });

    expect(outcome.failure).toBeNull();
    expect(declarationNames(outcome)).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('declines a repository with no Python at all', async () => {
    const outcome = await analyze({ 'README.md': '# docs\n' });

    expect(outcome.contribution).toBeNull();
    expect(outcome.depth).toBe('universal');
  });
});

describe('framework routes', () => {
  it('reads FastAPI decorators as endpoints', async () => {
    const outcome = await analyze({
      'app.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/users")\ndef list_users():\n    pass\n\n@app.post("/users")\ndef create_user():\n    pass\n',
    });

    expect(outcome.contribution?.annotations.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /users',
      'POST /users',
    ]);
    expect(outcome.depth).toBe('framework');
  });

  it('reads a Flask route, defaulting to GET', async () => {
    const outcome = await analyze({
      'app.py': 'from flask import Flask\n\napp = Flask(__name__)\n\n@app.route("/health")\ndef health():\n    pass\n',
    });

    expect(outcome.contribution?.annotations.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /health',
    ]);
  });

  it('reads the methods a Flask route declares', async () => {
    const outcome = await analyze({
      'app.py': 'from flask import Flask\n\napp = Flask(__name__)\n\n@app.route("/x", methods=["GET", "POST"])\ndef handler():\n    pass\n',
    });

    expect(outcome.contribution?.annotations.routes.map((route) => route.method)).toEqual(['GET', 'POST']);
  });

  it('does not call a decorator a route without a web framework import', async () => {
    // `.get(...)` as a decorator proves nothing on its own; plenty of libraries have one.
    const outcome = await analyze({
      'app.py': 'from mylib import cache\n\n@cache.get("/x")\ndef handler():\n    pass\n',
    });

    expect(outcome.contribution?.annotations.routes).toEqual([]);
  });

  it('marks every route INFERRED, the decorator being a convention', async () => {
    const outcome = await analyze({
      'app.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/x")\ndef handler():\n    pass\n',
    });

    for (const route of outcome.contribution?.annotations.routes ?? []) {
      expect(route.confidence).toBe('INFERRED');
    }
  });
});

/**
 * Constructor inference, which is Python's only widely-written statement of a local's type.
 *
 * `store = Store()` is how a Python program says what `store` is. Nothing else does, short of a
 * type annotation nobody is obliged to write — so this is the one rule that turns `store.save()`
 * from `root-type-unknown` into an edge.
 */
describe('local constructor inference', () => {
  it('binds a call on a local constructed from a class in this module', async () => {
    const outcome = await analyze({
      'app.py': `class Store:
    def save(self):
        pass


def run():
    store = Store()
    store.save()
`,
    });

    const call = outcome.contribution?.callGraph.calls.find(
      (entry) => entry.calleeText === 'store.save',
    );

    expect(call?.targetId).toBe('sym:app.py#Store.save');
    expect(call?.kind).toBe('instance-member');
    // Python rebinds at runtime, so this is the plausible reading rather than a proven one.
    expect(call?.confidence).toBe('INFERRED');
  });

  it('binds through the inheritance chain of the constructed class', async () => {
    const outcome = await analyze({
      'base.py': `class Base:
    def save(self):
        pass
`,
      'app.py': `from base import Base


class Store(Base):
    pass


def run():
    store = Store()
    store.save()
`,
    });

    expect(
      outcome.contribution?.callGraph.calls.find((entry) => entry.calleeText === 'store.save')
        ?.targetId,
    ).toBe('sym:base.py#Base.save');
  });

  it('does not infer a type from a call to a function', async () => {
    const outcome = await analyze({
      'app.py': `class Store:
    def save(self):
        pass


def make():
    return Store()


def run():
    store = make()
    store.save()
`,
    });

    // `make` is a function, not a class. Its return type is not written down anywhere Python
    // requires, so binding through it would be a guess.
    expect(
      outcome.contribution?.callGraph.calls.some((entry) => entry.calleeText === 'store.save'),
    ).toBe(false);
    expect(
      outcome.contribution?.callGraph.unresolved.find((entry) => entry.calleeText === 'store.save')
        ?.reason,
    ).toBe('root-type-unknown');
  });
});

/**
 * Calls into an installed distribution or the standard library.
 *
 * The name recorded is the top-level module as written, matching the IMPORTS edge exactly, so a
 * call onto `requests` and an import of `requests` reach the same node.
 */
describe('external calls', () => {
  it('records a call through a module imported from outside the repository', async () => {
    const outcome = await analyze({
      'app.py': `import requests


def run():
    requests.get("https://example.com")
`,
    });

    const external = outcome.contribution?.callGraph.externalCalls.find(
      (entry) => entry.calleeText === 'requests.get',
    );

    expect(external).toMatchObject({
      name: 'requests',
      origin: 'package',
      ecosystem: 'python',
      confidence: 'INFERRED',
    });
  });

  it('records a call through a name imported from an installed distribution', async () => {
    const outcome = await analyze({
      'app.py': `from flask import Flask


def run():
    Flask(__name__)
`,
    });

    expect(
      outcome.contribution?.callGraph.externalCalls.find((entry) => entry.calleeText === 'Flask'),
    ).toMatchObject({ name: 'flask', origin: 'package' });
  });

  it('separates the standard library from a distribution', async () => {
    const outcome = await analyze({
      'app.py': `import os


def run():
    os.getcwd()
`,
    });

    expect(
      outcome.contribution?.callGraph.externalCalls.find((entry) => entry.calleeText === 'os.getcwd'),
    ).toMatchObject({ name: 'os', origin: 'standard-library' });
  });

  it('does not treat an import inside this repository as external', async () => {
    const outcome = await analyze({
      'helpers.py': `def go():
    pass
`,
      'app.py': `import helpers


def run():
    helpers.go()
`,
    });

    expect(outcome.contribution?.callGraph.externalCalls).toHaveLength(0);
    expect(
      outcome.contribution?.callGraph.calls.find((entry) => entry.calleeText === 'helpers.go')
        ?.targetId,
    ).toBe('sym:helpers.py#go');
  });
});
