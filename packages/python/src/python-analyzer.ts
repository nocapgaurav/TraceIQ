import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { declined, evidenceReason, type AnalyzerOutcome, type LanguageAnalyzer } from '@traceiq/analyzer';
import { NO_ANNOTATIONS, type FrameworkAnnotations } from '@traceiq/framework';
import type { CallSiteIR, DeclarationIR, FileIR, ImportIR } from '@traceiq/ir';
import { fileId } from '@traceiq/shared';
import type { RepositoryInventory } from '@traceiq/scanner';

import {
  extractModule,
  type DecoratorFact,
  type HeritageFact,
  type LocalAssignmentFact,
} from './extract.js';
import { extractPythonRoutes } from './routes.js';
import { buildModuleIndex } from './module-index.js';
import { pythonParser } from './parser.js';
import { resolvePython, type ModuleInput } from './resolve.js';

export const PYTHON_ANALYZER = 'python';

const NOTHING_TO_READ = 'no Python sources here, so the Python analyser had nothing to read';

const PREAMBLE = 'Python sources were parsed and bound where the source establishes a name statically';

const FRAMEWORK_PREAMBLE =
  'Python sources were parsed and FastAPI or Flask route decorators recognised';

/** True of every Python call edge, and the reason none of them is ever `RESOLVED`. */
const RUNTIME_CAVEAT =
  'Python resolves names at runtime, so calls here are INFERRED rather than proven';

/**
 * A file this large is skipped rather than parsed.
 *
 * Generated Python — protobuf bindings, bundled vendor code — reaches megabytes, and parsing it
 * costs time to produce declarations nobody asked about. Skipped files are absent from
 * `coveredFiles`, so the region reports honestly on what was read.
 */
const FILE_BYTE_LIMIT = 2 * 1024 * 1024;

/**
 * The Python analyser.
 *
 * Parses with tree-sitter and resolves with rules of its own — see `resolve.ts` for what those rules
 * establish and, more importantly, what they refuse to. Nothing here executes the repository: no
 * interpreter runs, no `setup.py` is evaluated, no distribution is installed. Analysis is reading.
 */
export class PythonAnalyzer implements LanguageAnalyzer {
  readonly name = PYTHON_ANALYZER;

  readonly languages = ['python'] as const;

  /**
   * Loads the grammar ahead of `analyze`, which the contract requires to be synchronous.
   *
   * The parser is a WASM module and loading it is asynchronous, but an analyser's `analyze` cannot
   * be — the graph build is synchronous throughout. Preparing here keeps that boundary intact and
   * costs one load per process.
   */
  static async prepare(inventory: RepositoryInventory): Promise<PythonAnalyzer> {
    const analyzer = new PythonAnalyzer();

    await analyzer.#load(inventory);

    return analyzer;
  }

  #sources = new Map<string, string>();

  async #load(inventory: RepositoryInventory): Promise<void> {
    const files = pythonFilesOf(inventory);

    for (const file of files) {
      const size = inventory.files.find((entry) => entry.path === file)?.bytes ?? 0;

      if (size > FILE_BYTE_LIMIT) {
        continue;
      }

      try {
        this.#sources.set(file, await readFile(path.join(inventory.rootPath, file), 'utf8'));
      } catch {
        // Unreadable is skipped, not fatal: one file with the wrong permissions must not cost the
        // region its analysis.
      }
    }
  }

  analyze(input: { readonly inventory: RepositoryInventory }): AnalyzerOutcome {
    if (this.#sources.size === 0) {
      return declined(this.name, this.languages, NOTHING_TO_READ);
    }

    const parser = parserOrThrow();
    const paths = [...this.#sources.keys()].sort();
    const index = buildModuleIndex(paths);

    const files: FileIR[] = [];
    const declarations: DeclarationIR[] = [];
    const imports: ImportIR[] = [];
    const callSites: CallSiteIR[] = [];
    const heritageByPath = new Map<string, readonly HeritageFact[]>();
    const localsByPath = new Map<string, readonly LocalAssignmentFact[]>();
    const decorators: DecoratorFact[] = [];
    const covered: string[] = [];

    for (const filePath of paths) {
      const source = this.#sources.get(filePath) as string;
      const tree = parser.parse(source);

      if (tree === null) {
        continue;
      }

      // A file with syntax errors still yields the declarations tree-sitter recovered. Error
      // recovery is the reason a malformed module degrades instead of failing the region.
      const facts = extractModule({ repoRelativePath: filePath, root: tree.rootNode });

      files.push({
        id: fileId(filePath),
        path: filePath,
        isDeclarationFile: filePath.endsWith('.pyi'),
      });

      declarations.push(...facts.declarations);
      imports.push(...facts.imports);
      callSites.push(...facts.callSites);
      heritageByPath.set(filePath, facts.heritage);
      localsByPath.set(filePath, facts.localAssignments);
      decorators.push(...facts.decorators);
      covered.push(filePath);
    }

    const ir = {
      repository: { name: input.inventory.name, rootPath: input.inventory.rootPath },
      files,
      declarations,
      imports,
      exports: [],
      callSites,
      memberAccesses: [],
    };

    const modules: ModuleInput[] = paths.map((filePath) => {
      const moduleName = index.moduleNameOf(filePath);

      return {
        path: filePath,
        moduleName,
        isPackage: moduleName !== null && index.isPackage(moduleName),
        heritage: heritageByPath.get(filePath) ?? [],
        localAssignments: localsByPath.get(filePath) ?? [],
      };
    });

    const { resolved, callGraph } = resolvePython({ ir, modules, index });
    const annotations: FrameworkAnnotations = extractPythonRoutes({ ir, decorators, imports });

    const hasRoutes = annotations.routes.length > 0;
    const contribution = { ir, resolved, callGraph, annotations: annotations ?? NO_ANNOTATIONS };

    return {
      analyzer: this.name,
      languages: this.languages,
      coveredFiles: covered,
      depth: hasRoutes ? 'framework' : 'semantic',
      reason: evidenceReason({
        preamble: hasRoutes ? FRAMEWORK_PREAMBLE : PREAMBLE,
        contribution,
        // Python has no export statement, and this analyser reads no annotations. Reporting either
        // as "not found" would blame the source for something never looked for.
        omit: ['exports', 'type references'],
        caveat: RUNTIME_CAVEAT,
      }),
      contribution,
      failure: null,
    };
  }
}

/** Python sources the scan found, excluding stubs shadowed by an implementation. */
function pythonFilesOf(inventory: RepositoryInventory): readonly string[] {
  return inventory.files
    .filter((file) => file.language === 'python')
    .map((file) => file.path)
    .sort();
}

/**
 * The grammar, which `prepare` has already loaded.
 *
 * `analyze` is synchronous by contract, so the promise cannot be awaited here. Reaching this without
 * having prepared is a programming error in the composition root, and it says so.
 */
let ready: Awaited<ReturnType<typeof pythonParser>> | null = null;

export async function preloadPythonParser(): Promise<void> {
  ready = await pythonParser();
}

function parserOrThrow(): NonNullable<typeof ready> {
  if (ready === null) {
    throw new Error('the Python grammar was not loaded; call preloadPythonParser before analysing');
  }

  return ready;
}
