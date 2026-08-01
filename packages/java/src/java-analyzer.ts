import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { declined, evidenceReason, type AnalyzerOutcome, type LanguageAnalyzer } from '@traceiq/analyzer';
import type { FrameworkAnnotations } from '@traceiq/framework';
import type { CallSiteIR, DeclarationIR, FileIR, ImportIR } from '@traceiq/ir';
import { fileId } from '@traceiq/shared';
import type { RepositoryInventory } from '@traceiq/scanner';
import { parserFor } from '@traceiq/tree-sitter';
import type { NodeId } from '@traceiq/types';

import { extractCompilationUnit, type AnnotationFact } from './extract.js';
import { extractJavaFrameworks } from './frameworks.js';
import { resolveJava, type UnitInput } from './resolve.js';

export const JAVA_ANALYZER = 'java';

const NOTHING_TO_READ = 'no Java sources here, so the Java analyser had nothing to read';

const PREAMBLE =
  'Java sources were parsed and bound through their packages, imports and declared types';

const FRAMEWORK_PREAMBLE =
  'Java sources were parsed and Spring or Jakarta annotations recognised';

/**
 * True of every Java call edge, and the reason none of them is `RESOLVED`.
 *
 * Java's types are static but its dispatch is not: a field declared `Repository` may hold any
 * implementation, and the one that runs is decided at runtime. Binding to the declared type reaches
 * the declaration a reader would look for, which is useful and is not the same as proven.
 */
const DISPATCH_CAVEAT =
  'Java dispatches on the runtime type, so a call bound through a declared type is the most plausible target rather than a proven one';

/**
 * A file this large is skipped rather than parsed.
 *
 * Generated Java — protobuf builders, JAXB bindings, ANTLR parsers — reaches megabytes, and parsing it
 * costs time to produce declarations nobody asked about. Skipped files are absent from `coveredFiles`,
 * so the region reports honestly on what was read.
 */
const FILE_BYTE_LIMIT = 2 * 1024 * 1024;

/**
 * The Java analyser.
 *
 * Parses with tree-sitter and resolves with rules of its own — see `resolve.ts` for what those rules
 * establish and, more importantly, what they refuse to. **Nothing here compiles the repository**: no
 * javac runs, no Maven or Gradle build is invoked, no jar is downloaded or opened. Analysis is reading,
 * which is what makes it safe to point at an arbitrary public repository.
 *
 * The consequence is stated rather than hidden: without a classpath, a type from a dependency is a
 * *name*. That is why an import of `org.apache.commons.lang3.StringUtils` becomes an external node
 * named after its package rather than a resolved declaration, and why a call on a value whose type was
 * never declared in source is left unbound with a reason.
 */
export class JavaAnalyzer implements LanguageAnalyzer {
  readonly name = JAVA_ANALYZER;

  readonly languages = ['java'] as const;

  /**
   * Loads the grammar and the sources ahead of `analyze`, which the contract requires to be synchronous.
   *
   * The parser is a WASM module and reading files is asynchronous, but an analyser's `analyze` cannot
   * be — the graph build is synchronous throughout. Preparing here keeps that boundary intact.
   */
  static async prepare(inventory: RepositoryInventory): Promise<JavaAnalyzer> {
    const analyzer = new JavaAnalyzer();

    await analyzer.#load(inventory);

    return analyzer;
  }

  #sources = new Map<string, string>();

  async #load(inventory: RepositoryInventory): Promise<void> {
    for (const file of inventory.files) {
      if (file.language !== 'java' || file.bytes > FILE_BYTE_LIMIT) {
        continue;
      }

      try {
        this.#sources.set(file.path, await readFile(path.join(inventory.rootPath, file.path), 'utf8'));
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

    const files: FileIR[] = [];
    const declarations: DeclarationIR[] = [];
    const imports: ImportIR[] = [];
    const callSites: CallSiteIR[] = [];
    const annotations: AnnotationFact[] = [];
    const units: UnitInput[] = [];
    const importsByFile = new Map<NodeId, string[]>();
    const covered: string[] = [];

    for (const filePath of paths) {
      const source = this.#sources.get(filePath) as string;
      const tree = parser.parse(source);

      if (tree === null) {
        continue;
      }

      // A file with syntax errors still yields the declarations tree-sitter recovered. Error recovery
      // is the reason a malformed file degrades instead of failing the region.
      const facts = extractCompilationUnit({ repoRelativePath: filePath, root: tree.rootNode });

      files.push({ id: fileId(filePath), path: filePath, isDeclarationFile: false });
      declarations.push(...facts.declarations);
      imports.push(...facts.imports);
      callSites.push(...facts.callSites);
      annotations.push(...facts.annotations);

      importsByFile.set(
        fileId(filePath),
        facts.imports.map((statement) => statement.moduleSpecifier),
      );

      units.push({
        path: filePath,
        packageName: facts.packageName,
        heritage: facts.heritage,
        typeReferences: facts.typeReferences,
        localVariables: facts.localVariables,
        methodReturns: facts.methodReturns,
        imports: facts.imports.map((statement) => ({
          specifier: statement.moduleSpecifier,
          // A wildcard was recorded as a namespace binding, which is the shape that says so.
          isWildcard: statement.bindings.some((binding) => binding.kind === 'namespace'),
          isStatic: staticImportOf(source, statement.moduleSpecifier),
        })),
      });

      covered.push(filePath);
    }

    const ir = {
      repository: { name: input.inventory.name, rootPath: input.inventory.rootPath },
      files,
      declarations,
      imports,
      // Java has no export statement. Visibility is a modifier, which the declarations already carry,
      // and emitting exports would invent a construct the language does not have.
      exports: [],
      callSites,
      memberAccesses: [],
    };

    const { resolved, callGraph } = resolveJava({ ir, units });
    const frameworkAnnotations: FrameworkAnnotations = extractJavaFrameworks({
      ir,
      annotations,
      importsByFile,
    });

    const hasRoutes = frameworkAnnotations.routes.length > 0;
    const contribution = { ir, resolved, callGraph, annotations: frameworkAnnotations };

    return {
      analyzer: this.name,
      languages: this.languages,
      coveredFiles: covered,
      depth: hasRoutes ? 'framework' : 'semantic',
      reason: evidenceReason({
        preamble: hasRoutes ? FRAMEWORK_PREAMBLE : PREAMBLE,
        contribution,
        // Java has no export statement, so reporting "no exports were found" would blame the source
        // for something never looked for.
        omit: ['exports'],
        caveat: DISPATCH_CAVEAT,
      }),
      contribution,
      failure: null,
    };
  }
}

/**
 * Whether a specifier was written as a static import.
 *
 * Read from the source text rather than carried on `ImportIR`, because the IR's import shape is
 * language-independent and has no notion of a static member import. The alternative — adding a Java
 * field to a shared contract — would push one language's grammar into every other analyser.
 */
function staticImportOf(source: string, specifier: string): boolean {
  const escaped = specifier.replaceAll('.', '\\.');

  return new RegExp(`import\\s+static\\s+${escaped}\\b`).test(source);
}

let ready: Awaited<ReturnType<typeof parserFor>> | null = null;

export async function preloadJavaParser(): Promise<void> {
  ready = await parserFor('java');
}

function parserOrThrow(): NonNullable<typeof ready> {
  if (ready === null) {
    throw new Error('the Java grammar was not loaded; call preloadJavaParser before analysing');
  }

  return ready;
}
