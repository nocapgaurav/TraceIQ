import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { declined, evidenceReason, type AnalyzerOutcome, type LanguageAnalyzer } from '@traceiq/analyzer';
import type { FrameworkAnnotations } from '@traceiq/framework';
import type { CallSiteIR, DeclarationIR, FileIR, ImportIR } from '@traceiq/ir';
import { fileId } from '@traceiq/shared';
import type { RepositoryInventory } from '@traceiq/scanner';
import { parserFor } from '@traceiq/tree-sitter';
import type { NodeId } from '@traceiq/types';

import { extractSourceFile, isExportedName } from './extract.js';
import { extractGoFrameworks } from './frameworks.js';
import {
  buildPackageIndex,
  directoryOf,
  modulePathOf,
  type ModuleRoot,
  type PackageMember,
} from './package-index.js';
import { resolveGo, type FileInput } from './resolve.js';

export const GO_ANALYZER = 'go';

const NOTHING_TO_READ = 'no Go sources here, so the Go analyser had nothing to read';

const PREAMBLE = 'Go sources were parsed and bound through their module path, packages and imports';

const FRAMEWORK_PREAMBLE = 'Go sources were parsed and router registrations recognised';

/**
 * The caveat, and it is narrower than the other grammar-backed analysers'.
 *
 * Go's package resolution is exact — an import path is the module path plus a directory — so imports
 * and package-qualified calls are `RESOLVED` rather than inferred. What remains inferred is a call
 * through a value: an interface variable dispatches at runtime, and a local's type comes from Go's own
 * inference, which this analyser does not reproduce.
 */
const DISPATCH_CAVEAT =
  'a call through an interface value dispatches at runtime, and a call on a local whose type Go infers is not bound at all';

const FILE_BYTE_LIMIT = 2 * 1024 * 1024;

/**
 * The Go analyser.
 *
 * Parses with tree-sitter and resolves with Go's own package arithmetic. **Nothing here builds the
 * repository**: no `go build` runs, no module is downloaded, no `GOPATH` or module cache is read. The
 * only file consulted beyond the sources is `go.mod`, and only for its `module` line — which is what
 * turns an import path into a directory.
 *
 * That single fact is why Go reaches higher confidence than Java or Python for the same class of
 * question: `github.com/acme/svc/internal/store` resolves to `internal/store/` by construction, with no
 * search path to guess at.
 */
export class GoAnalyzer implements LanguageAnalyzer {
  readonly name = GO_ANALYZER;

  readonly languages = ['go'] as const;

  static async prepare(inventory: RepositoryInventory): Promise<GoAnalyzer> {
    const analyzer = new GoAnalyzer();

    await analyzer.#load(inventory);

    return analyzer;
  }

  #sources = new Map<string, string>();
  #modules: ModuleRoot[] = [];

  async #load(inventory: RepositoryInventory): Promise<void> {
    for (const file of inventory.files) {
      if (file.language === 'go' && file.bytes <= FILE_BYTE_LIMIT) {
        try {
          this.#sources.set(file.path, await readFile(path.join(inventory.rootPath, file.path), 'utf8'));
        } catch {
          // Unreadable is skipped, not fatal.
        }

        continue;
      }

      // `go.mod` is the only non-source file read, and only for its module path.
      if (path.basename(file.path) === 'go.mod') {
        try {
          const contents = await readFile(path.join(inventory.rootPath, file.path), 'utf8');
          const modulePath = modulePathOf(contents);

          if (modulePath !== null) {
            this.#modules.push({ modulePath, directory: directoryOf(file.path) });
          }
        } catch {
          // A module whose go.mod cannot be read simply resolves no imports; its files are still parsed.
        }
      }
    }
  }

  analyze(input: { readonly inventory: RepositoryInventory }): AnalyzerOutcome {
    if (this.#sources.size === 0) {
      return declined(this.name, this.languages, NOTHING_TO_READ);
    }

    const parser = parserOrThrow();
    const paths = [...this.#sources.keys()].sort();

    const files: FileIR[] = [];
    const declarations: DeclarationIR[] = [];
    const imports: ImportIR[] = [];
    const callSites: CallSiteIR[] = [];
    const fileInputs: FileInput[] = [];
    const members: PackageMember[] = [];
    const packageNames = new Map<string, string>();
    const importsByFile = new Map<NodeId, string[]>();
    const covered: string[] = [];
    const routeCalls: Parameters<typeof extractGoFrameworks>[0]['callTexts'][number][] = [];

    for (const filePath of paths) {
      const source = this.#sources.get(filePath) as string;
      const tree = parser.parse(source);

      if (tree === null) {
        continue;
      }

      const facts = extractSourceFile({ repoRelativePath: filePath, root: tree.rootNode });
      const directory = directoryOf(filePath);

      files.push({ id: fileId(filePath), path: filePath, isDeclarationFile: false });
      declarations.push(...facts.declarations);
      imports.push(...facts.imports);
      callSites.push(...facts.callSites);

      if (facts.packageName !== null) {
        packageNames.set(directory, facts.packageName);
      }

      for (const declaration of facts.declarations) {
        members.push({
          declarationId: declaration.id,
          name: declaration.name,
          directory,
          isExported: isExportedName(declaration.name),
        });
      }

      const importAliases = new Map<string, string>();

      for (const statement of facts.imports) {
        for (const binding of statement.bindings) {
          importAliases.set(binding.localName, statement.moduleSpecifier);
        }
      }

      importsByFile.set(
        fileId(filePath),
        facts.imports.map((statement) => statement.moduleSpecifier),
      );

      fileInputs.push({
        path: filePath,
        packageName: facts.packageName,
        embeddings: facts.embeddings,
        typeReferences: facts.typeReferences,
        receivers: facts.receivers,
        localVariables: facts.localVariables,
        resultTypes: facts.resultTypes,
        importAliases,
      });

      // Route registrations are call sites whose first argument is a path and whose remaining ones
      // are handlers. Both are read from `CallSiteIR.arguments`, which the extractor now populates —
      // it replaced a heuristic that re-read the source line and took the first quoted run on it,
      // and which therefore could not see a handler at all.
      for (const site of facts.callSites) {
        routeCalls.push({
          fileId: fileId(filePath),
          directory,
          enclosingDeclarationId: site.enclosingDeclarationId,
          memberName: site.calleeMemberName,
          firstStringArgument:
            site.arguments.find((argument) => argument.stringValue !== null)?.stringValue ?? null,
          handlerNames: site.arguments
            .filter((argument) => argument.stringValue === null)
            .map((argument) => argument.text),
          location: site.location,
        });
      }

      covered.push(filePath);
    }

    const index = buildPackageIndex({ modules: this.#modules, members, packageNames });

    const ir = {
      repository: { name: input.inventory.name, rootPath: input.inventory.rootPath },
      files,
      declarations,
      imports,
      // Go has no export statement: exportedness is the case of the first letter, which the
      // declarations already carry. Emitting exports would invent a construct the language lacks.
      exports: [],
      callSites,
      memberAccesses: [],
    };

    const { resolved, callGraph } = resolveGo({ ir, files: fileInputs, index });
    const annotations: FrameworkAnnotations = extractGoFrameworks({
      ir,
      importsByFile,
      callTexts: routeCalls,
      index,
    });

    const hasRoutes = annotations.routes.length > 0;
    const contribution = { ir, resolved, callGraph, annotations };

    return {
      analyzer: this.name,
      languages: this.languages,
      coveredFiles: covered,
      depth: hasRoutes ? 'framework' : 'semantic',
      reason: evidenceReason({
        preamble: hasRoutes ? FRAMEWORK_PREAMBLE : PREAMBLE,
        contribution,
        omit: ['exports'],
        caveat: DISPATCH_CAVEAT,
      }),
      contribution,
      failure: null,
    };
  }
}

let ready: Awaited<ReturnType<typeof parserFor>> | null = null;

export async function preloadGoParser(): Promise<void> {
  ready = await parserFor('go');
}

function parserOrThrow(): NonNullable<typeof ready> {
  if (ready === null) {
    throw new Error('the Go grammar was not loaded; call preloadGoParser before analysing');
  }

  return ready;
}
