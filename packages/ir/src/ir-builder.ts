import path from 'node:path';

import type { ProjectContext } from '@traceiq/project-host';
import { fileId, normalizeRepoPath } from '@traceiq/shared';

import { DeclarationCollector } from './declaration-collector.js';
import { extractDeclarations, type ExtractionSink } from './declaration-extractor.js';
import { extractExports } from './export-extractor.js';
import { extractExpressions } from './expression-extractor.js';
import { extractImports } from './import-extractor.js';
import type {
  CallSiteIR,
  ExportIR,
  FileIR,
  ImportIR,
  MemberAccessIR,
  RepositoryIR,
} from './types.js';

export class IrBuildError extends Error {
  constructor(reason: string, options?: { cause: unknown }) {
    super(`Cannot build repository IR: ${reason}`, options);
    this.name = 'IrBuildError';
  }
}

/**
 * Converts a loaded TypeScript project into the TraceIQ Intermediate
 * Representation.
 *
 * The builder reads syntax only. It holds the `ProjectContext` for the duration of
 * one `build` call and keeps nothing afterwards, and no ts-morph value reaches the
 * result: everything in a `RepositoryIR` is a plain object.
 *
 * The type checker is deliberately unused. Every fact recorded here is visible in
 * the syntax tree, which is what makes the IR cheap to produce and safe to treat
 * as a stable contract.
 */
export class IrBuilder {
  build(context: ProjectContext): RepositoryIR {
    const files: FileIR[] = [];
    const imports: ImportIR[] = [];
    const exports: ExportIR[] = [];
    const callSites: CallSiteIR[] = [];
    const memberAccesses: MemberAccessIR[] = [];
    const declarations = new DeclarationCollector();

    for (const file of context.sourceFiles) {
      const repoRelativePath = this.repoRelativePathOf(context.rootPath, file.getFilePath());
      const id = fileId(repoRelativePath);

      files.push({
        id,
        path: repoRelativePath,
        isDeclarationFile: file.isDeclarationFile(),
      });

      const sink: ExtractionSink = {
        declarations,
        inlineExports: [],
        declarationIdByNode: new Map(),
      };

      extractDeclarations({ file, fileId: id, repoRelativePath, sink });

      // Declarations are walked first, so every expression can be attributed to the
      // declaration containing it.
      const expressions = extractExpressions({
        file,
        fileId: id,
        declarationIdByNode: sink.declarationIdByNode,
      });

      callSites.push(...expressions.callSites);
      memberAccesses.push(...expressions.memberAccesses);

      const { inlineExports } = sink;

      // Inline exports precede statement exports so a file's exports read in the
      // order a reader encounters them.
      exports.push(...inlineExports, ...extractExports(file, id));
      imports.push(...extractImports(file, id));
    }

    return {
      repository: {
        name: path.basename(context.rootPath),
        rootPath: context.rootPath,
      },
      files,
      declarations: declarations.toArray(),
      imports,
      exports,
      callSites,
      memberAccesses,
    };
  }

  /**
   * A file outside the repository root, or one whose name cannot form a canonical
   * repository-relative path, fails the build rather than being dropped. Silently
   * omitting a file would leave the IR quietly incomplete.
   */
  private repoRelativePathOf(rootPath: string, absolutePath: string): string {
    try {
      return normalizeRepoPath(path.relative(rootPath, absolutePath));
    } catch (cause) {
      throw new IrBuildError(`${absolutePath} is not addressable within ${rootPath}`, { cause });
    }
  }
}
