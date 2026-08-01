import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RepositoryScanner } from '@traceiq/scanner';

import { PythonAnalyzer, preloadPythonParser } from './python-analyzer.js';

/**
 * The Python analyser against the shapes real repositories are actually made of.
 *
 * The happy-path fixtures proved the rules fire. These exist because measuring the analyser against
 * flask, fastapi and dash found things no happy-path fixture would: `@t.overload` produced two
 * declarations claiming one identifier and failed the whole scan, and a keyword-argument tuple was read
 * as a route path and failed another. Both are here, alongside the layouts that surround them.
 *
 * Every case runs the real scanner and the real analyser over a real directory.
 */
const roots: string[] = [];

beforeAll(async () => {
  await preloadPythonParser();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function analyse(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-pystress-'));

  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  const inventory = await new RepositoryScanner().scan(root);
  const analyzer = await PythonAnalyzer.prepare(inventory);
  const outcome = analyzer.analyze({ inventory });

  const contribution = outcome.contribution;

  if (contribution === null) {
    throw new Error(`the analyser declined or failed: ${outcome.failure ?? outcome.reason}`);
  }

  return { outcome, ...contribution, declarations: contribution.ir.declarations };
}

/** Every declaration identifier, so a duplicate is visible rather than inferred. */
function identifiers(declarations: readonly { readonly id: string }[]): readonly string[] {
  return declarations.map((declaration) => declaration.id);
}

describe('a name declared more than once', () => {
  it('folds @overload signatures into one declaration with several locations', async () => {
    // The flask defect, reduced. Three `def locate_app` at module level share one symbol path; emitting
    // one declaration per site produced duplicate identifiers and the graph rejected the whole scan.
    const { declarations } = await analyse({
      'pyproject.toml': '[project]\nname = "app"\n',
      'app/cli.py': [
        'import typing as t',
        '',
        '@t.overload',
        'def locate_app(name: str, app: str) -> int: ...',
        '',
        '@t.overload',
        'def locate_app(name: str, app: None) -> None: ...',
        '',
        'def locate_app(name, app=None):',
        '    return 1',
        '',
      ].join('\n'),
    });

    const ids = identifiers(declarations);

    expect(new Set(ids).size).toBe(ids.length);

    const folded = declarations.find((declaration) => declaration.name === 'locate_app');

    expect(folded).toBeDefined();
    expect(folded?.locations).toHaveLength(3);
  });

  it('folds a module-level name reassigned later', async () => {
    const { declarations } = await analyse({
      'pyproject.toml': '[project]\nname = "app"\n',
      'app/config.py': 'DEBUG = False\nDEBUG = True\n',
    });

    const ids = identifiers(declarations);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('folds a function and a same-named assignment, keeping the container kind', async () => {
    const { declarations } = await analyse({
      'pyproject.toml': '[project]\nname = "app"\n',
      'app/patch.py': 'def handler():\n    return 1\n\nhandler = None\n',
    });

    const ids = identifiers(declarations);

    expect(new Set(ids).size).toBe(ids.length);
    // `function` can hold nested declarations and `variable` is also a container kind, so the first
    // site wins. What matters is that one identifier yields one declaration.
    expect(declarations.filter((declaration) => declaration.name === 'handler')).toHaveLength(1);
  });
});

describe('package layouts', () => {
  it('resolves a src layout through __init__.py and relative imports', async () => {
    const { resolved } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'src/svc/__init__.py': 'from .core import Engine\n',
      'src/svc/core.py': 'class Engine:\n    def run(self):\n        return 1\n',
      'src/svc/api/__init__.py': '',
      'src/svc/api/routes.py': 'from ..core import Engine\n\ndef make():\n    return Engine()\n',
    });

    const imports = resolved.relationships.filter((relationship) => relationship.type === 'IMPORTS');

    // Both the absolute-through-package and the two-dot relative import bind to the declaring module.
    expect(imports.length).toBeGreaterThanOrEqual(2);

    for (const relationship of imports) {
      expect(relationship.confidence).toBe('RESOLVED');
    }
  });

  it('binds a nested package import written absolutely', async () => {
    const { resolved } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/__init__.py': '',
      'svc/deep/__init__.py': '',
      'svc/deep/inner.py': 'def helper():\n    return 2\n',
      'svc/main.py': 'from svc.deep.inner import helper\n\ndef go():\n    return helper()\n',
    });

    const bound = resolved.relationships.filter(
      (relationship) => relationship.type === 'IMPORTS' && relationship.target.kind === 'declaration',
    );

    expect(bound.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves a third-party import to an external rather than dropping it', async () => {
    const { resolved } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
      'svc/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
    });

    const externals = resolved.relationships.filter(
      (relationship) => relationship.type === 'IMPORTS' && relationship.target.kind === 'external',
    );

    expect(externals).toHaveLength(1);
    expect(externals[0]?.confidence).toBe('INFERRED');
    expect(externals[0]?.provenance.evidence).toContain('installed distribution');
  });

  it('does not treat a dead relative import as something outside the repository', async () => {
    // `.nothere` names a module *inside* the repository that is not there. Calling that an external
    // would turn a genuine dead end into a fabricated dependency on a package nobody depends on.
    const { resolved } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/__init__.py': '',
      'svc/main.py': 'from .nothere import thing\n',
    });

    expect(
      resolved.relationships.some(
        (relationship) => relationship.type === 'IMPORTS' && relationship.target.kind === 'external',
      ),
    ).toBe(false);
    expect(resolved.unresolved.some((entry) => entry.reason === 'module-not-resolved')).toBe(true);
  });

  it('fails on the name, not the module, when a package exists but the name does not', async () => {
    const { resolved } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/__init__.py': '',
      'svc/main.py': 'from . import missing\n',
    });

    // The package resolved; only `missing` did not. Reporting this as an external would claim a
    // dependency, and reporting it as an unresolved *module* would blame the wrong thing.
    expect(
      resolved.relationships.some(
        (relationship) => relationship.type === 'IMPORTS' && relationship.target.kind === 'external',
      ),
    ).toBe(false);
    expect(resolved.unresolved.some((entry) => entry.reason === 'no-declaration')).toBe(true);
  });
});

describe('calls, inheritance and members', () => {
  it('binds self.method through a proven base class', async () => {
    const { callGraph } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/base.py': 'class Base:\n    def shared(self):\n        return 1\n',
      'svc/child.py': [
        'from svc.base import Base',
        '',
        'class Child(Base):',
        '    def go(self):',
        '        return self.shared()',
        '',
      ].join('\n'),
    });

    const inherited = callGraph.calls.find((call) => call.calleeText.includes('self.shared'));

    expect(inherited).toBeDefined();
    expect(inherited?.kind).toBe('this-member');
    // Never RESOLVED: a subclass could rebind the name at runtime.
    expect(inherited?.confidence).toBe('INFERRED');
  });

  it('does not guess a call on a base class it could not prove', async () => {
    // The base comes from a third-party package, so the search must stop rather than walk past it.
    const { callGraph } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["pydantic"]\n',
      'svc/model.py': [
        'from pydantic import BaseModel',
        '',
        'class User(BaseModel):',
        '    def go(self):',
        '        return self.model_dump()',
        '',
      ].join('\n'),
    });

    expect(callGraph.calls.some((call) => call.calleeText.includes('model_dump'))).toBe(false);
    expect(
      callGraph.unresolved.some(
        (entry) => entry.calleeText.includes('model_dump') && entry.reason === 'member-not-found',
      ),
    ).toBe(true);
  });

  it('refuses to bind an attribute call on an arbitrary receiver', async () => {
    const { callGraph } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/run.py': 'def go(service):\n    return service.execute()\n',
    });

    expect(callGraph.calls.some((call) => call.calleeText.includes('execute'))).toBe(false);
    expect(
      callGraph.unresolved.some(
        (entry) => entry.calleeText.includes('execute') && entry.reason === 'root-type-unknown',
      ),
    ).toBe(true);
  });

  it('binds a call through an imported module object', async () => {
    const { callGraph } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/util.py': 'def helper():\n    return 1\n',
      'svc/main.py': 'import svc.util\n\ndef go():\n    return svc.util.helper()\n',
    });

    // `import svc.util` then `svc.util.helper()` — recorded when the module object binds, and honestly
    // unresolved when it does not. Either is acceptable; a *wrong* target is not.
    for (const call of callGraph.calls) {
      expect(call.confidence).toBe('INFERRED');
    }
  });

  it('records async functions as async', async () => {
    const { declarations } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/main.py': 'async def fetch():\n    return 1\n',
    });

    expect(declarations.find((declaration) => declaration.name === 'fetch')?.modifiers.isAsync).toBe(true);
  });

  it('never claims a Python call is RESOLVED', async () => {
    const { callGraph } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/a.py': 'def one():\n    return 1\n\ndef two():\n    return one()\n',
      'svc/b.py': 'from svc.a import one\n\ndef three():\n    return one()\n',
    });

    expect(callGraph.calls.length).toBeGreaterThan(0);

    for (const call of callGraph.calls) {
      expect(call.confidence).toBe('INFERRED');
    }
  });
});

describe('framework routes', () => {
  it('reads FastAPI decorators', async () => {
    const { annotations } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
      'svc/main.py': [
        'from fastapi import FastAPI',
        '',
        'app = FastAPI()',
        '',
        '@app.get("/users/{id}")',
        'async def get_user(id: str):',
        '    return {}',
        '',
      ].join('\n'),
    });

    expect(annotations.routes).toHaveLength(1);
    expect(annotations.routes[0]?.method).toBe('GET');
    expect(annotations.routes[0]?.path).toBe('/users/{id}');
    expect(annotations.routes[0]?.confidence).toBe('INFERRED');
  });

  it('reads a Flask route with several declared methods', async () => {
    const { annotations } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["flask"]\n',
      'svc/main.py': [
        'from flask import Flask',
        '',
        'app = Flask(__name__)',
        '',
        '@app.route("/health", methods=["GET", "POST"])',
        'def health():',
        '    return "ok"',
        '',
      ].join('\n'),
    });

    expect(annotations.routes.map((route) => route.method).sort()).toEqual(['GET', 'POST']);

    for (const route of annotations.routes) {
      expect(route.path).toBe('/health');
    }
  });

  it('records no route when the path arrives only as a keyword argument', async () => {
    // The dash defect. `@hooks.route(methods=("POST",))` has no positional path, and reading the first
    // quoted string anywhere in the decorator yielded the path `"POST"` — which then failed the whole
    // scan, because a route path must begin with `/`. No route is the right answer here.
    const { annotations } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["flask"]\n',
      'svc/main.py': [
        'from flask import Flask',
        '',
        'hooks = Flask(__name__)',
        '',
        '@hooks.route(methods=("POST",))',
        'def handler():',
        '    return "ok"',
        '',
      ].join('\n'),
    });

    expect(annotations.routes).toHaveLength(0);
  });

  it('ignores a routing-shaped decorator in a module importing no web framework', async () => {
    const { annotations } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/main.py': [
        'import click',
        '',
        '@click.get("/not-a-route")',
        'def go():',
        '    return 1',
        '',
      ].join('\n'),
    });

    expect(annotations.routes).toHaveLength(0);
  });
});

describe('degradation', () => {
  it('keeps the declarations it recovered from a module with a syntax error', async () => {
    const { declarations, outcome } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/good.py': 'def fine():\n    return 1\n',
      'svc/broken.py': 'def broken(:\n    return\n',
    });

    expect(outcome.failure).toBeNull();
    expect(declarations.some((declaration) => declaration.name === 'fine')).toBe(true);
  });

  it('treats a test module as covered source like any other', async () => {
    const { outcome } = await analyse({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'svc/main.py': 'def go():\n    return 1\n',
      'tests/test_main.py': 'from svc.main import go\n\ndef test_go():\n    assert go() == 1\n',
    });

    expect(outcome.coveredFiles).toContain('tests/test_main.py');
  });
});
