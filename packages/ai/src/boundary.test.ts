import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The architecture's constraints, as tests.
 *
 * Every rule the milestone set is checkable against the source and the build output, so none of them rests
 * on a claim in a README. If one of these fails, a boundary has moved.
 */
const SOURCE = path.join(import.meta.dirname);
const DIST = path.join(import.meta.dirname, '..', 'dist');

async function filesIn(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(directory, entry.name));
}

async function sourceFiles(): Promise<{ readonly file: string; readonly text: string }[]> {
  const files = await filesIn(SOURCE, '.ts');

  return Promise.all(
    files
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test-helper.ts'))
      .map(async (file) => ({ file: path.basename(file), text: await readFile(file, 'utf8') })),
  );
}

/** Every `import`/`export ... from` specifier that is not relative. */
function externalSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+'([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((specifier) => !specifier.startsWith('.'));
}

describe('AI never reaches the repository itself', () => {
  it('imports no backend package at runtime', async () => {
    const compiled = await filesIn(DIST, '.js');

    expect(compiled.length).toBeGreaterThan(0);

    for (const file of compiled) {
      const text = await readFile(file, 'utf8');

      // A `@traceiq/…` string may appear as a provenance label. An *import* of one may not.
      expect(externalSpecifiers(text).filter((specifier) => specifier.startsWith('@traceiq/'))).toEqual([]);
      expect(text).not.toMatch(/require\(['"]@traceiq/);
    }
  });

  it('imports @traceiq/context as types only, and nothing else from @traceiq', async () => {
    for (const { file, text } of await sourceFiles()) {
      const traceiq = externalSpecifiers(text).filter((specifier) => specifier.startsWith('@traceiq/'));

      expect(traceiq.filter((specifier) => specifier !== '@traceiq/context'), file).toEqual([]);

      for (const match of text.matchAll(/(?:^|\n)\s*(import|export)([^;]*?)from\s+'@traceiq\/context'/g)) {
        // `import type { … }` is erased at compile time; a value import would put a module in the closure.
        expect(match[2], `${file}: @traceiq/context must be imported as a type only`).toMatch(/^\s+type\s/);
      }
    }
  });

  it('never imports a database, a compiler or a graph reader', async () => {
    for (const { file, text } of await sourceFiles()) {
      for (const specifier of externalSpecifiers(text)) {
        expect(
          ['better-sqlite3', 'ts-morph', 'fast-glob', 'express'].includes(specifier),
          `${file} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it('declares exactly one runtime dependency, and it is the context contract', async () => {
    const manifest = JSON.parse(await readFile(path.join(DIST, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@traceiq/context']);
  });

  it('names no capability it must not call directly', async () => {
    // The AI layer consumes only RepositoryContext. A call into a capability would be a second inbound
    // path and would duplicate intelligence that already exists.
    const forbidden = [
      'QueryEngine',
      'RepositoryExplorer',
      'SymbolExplainer',
      'ImpactAnalyzer',
      'RepositoryHealthAnalyzer',
      'RepositoryGraphApi',
      'RepositoryPipeline',
      'CachingGraph',
    ];

    for (const { file, text } of await sourceFiles()) {
      for (const name of forbidden) {
        expect(text.includes(name), `${file} mentions ${name}`).toBe(false);
      }
    }
  });

  it('does not search the repository', async () => {
    // Subject resolution is repository search and belongs to the Explorer. This layer takes a resolved
    // ContextRequest, so nothing here may look a subject up.
    for (const { file, text } of await sourceFiles()) {
      expect(/\bsearch\s*\(/.test(text), `${file} calls something named search`).toBe(false);
    }
  });
});

describe('no vendor leaks through the provider-agnostic package', () => {
  it('names no model vendor anywhere in the source', async () => {
    for (const { file, text } of await sourceFiles()) {
      expect(/ollama|openai|anthropic|llama|mistral|gemini|claude|gpt-/i.test(text), `${file} names a vendor`).toBe(
        false,
      );
    }
  });

  it('names no model vendor anywhere in the published types', async () => {
    // A vendor named in a `.d.ts` — even in a comment — is a leak into the public surface.
    for (const file of await filesIn(DIST, '.d.ts')) {
      const text = await readFile(file, 'utf8');

      expect(/ollama|openai|anthropic|llama|mistral|gemini|claude|gpt-/i.test(text), `${path.basename(file)}`).toBe(
        false,
      );
    }
  });

  it('has no registry, because a registry would put vendor selection in this package', async () => {
    for (const { file, text } of await sourceFiles()) {
      expect(/ProviderRegistry/.test(text), file).toBe(false);
    }
  });
});

describe('the source stays text', () => {
  it('contains no raw control byte, so grep cannot silently skip a file', async () => {
    // Three files in this package were once written with a literal NUL inside a string. Nothing failed:
    // the NUL worked as a separator and every test passed. But `file` reported them as binary data and
    // `grep` skipped them entirely — which silently defeated the boundary audits above, since a grep that
    // matches nothing looks exactly like a grep that found nothing wrong. A separator belongs in a `\u0000`
    // escape.
    const files = [...(await filesIn(SOURCE, '.ts')), ...(await filesIn(DIST, '.js'))];

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const bytes = await readFile(file);
      const offending = bytes.findIndex((byte) => byte < 0x09 || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f);

      expect(offending, `${path.basename(file)} has a control byte at ${offending}`).toBe(-1);
    }
  });
});

describe('nothing is persisted', () => {
  it('defines conversation as types only, with no store', async () => {
    const text = await readFile(path.join(SOURCE, 'conversation.ts'), 'utf8');

    expect(text).not.toMatch(/ConversationStore/);
    expect(text).not.toMatch(/\bclass\b/);
    expect(externalSpecifiers(text).filter((specifier) => specifier.startsWith('node:'))).toEqual([]);
  });

  it('touches the filesystem nowhere outside the tests', async () => {
    for (const { file, text } of await sourceFiles()) {
      for (const specifier of externalSpecifiers(text)) {
        expect(['node:fs', 'node:fs/promises', 'node:path', 'node:os'].includes(specifier), `${file}`).toBe(false);
      }
    }
  });
});
