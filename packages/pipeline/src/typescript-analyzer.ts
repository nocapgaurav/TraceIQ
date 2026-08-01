import {
  declined,
  evidenceReason,
  type AnalyzerContribution,
  type AnalyzerOutcome,
  type LanguageAnalyzer,
} from '@traceiq/analyzer';
import { CallGraphResolver } from '@traceiq/call-graph';
import { FrameworkExtractor } from '@traceiq/framework';
import { IrBuilder, type RepositoryIR } from '@traceiq/ir';
import { planAnalysisUnits, ProjectHost, type AnalysisUnit } from '@traceiq/project-host';

import { mergeContributions, mergeIr } from './merge-contributions.js';
import { DeclarationIndex, Resolver } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';

export const TYPESCRIPT_ANALYZER = 'typescript';

/**
 * How the sources were read. What was *found* in them is appended by `evidenceReason`, because a
 * fixed sentence claimed evidence this analyser had not necessarily produced — see that function.
 */
/** Extensions the compiler reads as JavaScript rather than TypeScript. */
const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

/**
 * How the sources were read, naming the language they are written in.
 *
 * **`'the TypeScript compiler read these sources'` is true and reads wrong.** Every other analyser
 * opens by naming the language — "Java sources were parsed", "Go sources were parsed" — and a user
 * scanning express, 141 JavaScript files with no TypeScript in it, was told about a TypeScript
 * compiler and left to work out whether their repository had been analysed at all. The compiler is
 * still named, because which tool read the code is exactly what justifies the depth claimed; what
 * changes is that the sentence also says what it read.
 */
function preambleFor(paths: readonly string[], hasFrameworkFacts: boolean): string {
  const javascript = paths.filter((entry) =>
    JAVASCRIPT_EXTENSIONS.some((extension) => entry.endsWith(extension)),
  ).length;

  const written =
    javascript === 0
      ? 'TypeScript sources'
      : javascript === paths.length
        ? 'JavaScript sources'
        : 'TypeScript and JavaScript sources';

  const preamble = `the TypeScript compiler read these ${written}`;

  return hasFrameworkFacts ? `${preamble} and Express conventions were recognised` : preamble;
}

const NOTHING_TO_READ =
  'no TypeScript or JavaScript sources here, so the compiler-backed analyser had nothing to read';

/**
 * The compiler-backed analyser, for TypeScript **and JavaScript**.
 *
 * One analyser rather than two, because the TypeScript compiler reads both. With `allowJs` a `.js`,
 * `.jsx`, `.mjs` or `.cjs` file goes through the same program, the same checker and the same
 * binding rules as a `.ts` file — it gets declarations, imports, exports, inheritance and
 * checker-resolved calls, and CommonJS `require`/`module.exports` are understood natively. A second
 * JavaScript analyser would be a reimplementation of work already done, and would produce a second
 * program that could disagree with this one.
 *
 * **Compilation is bounded, one semantic region at a time.** This used to build a single program
 * over the whole repository, on the reasoning that the checker is whole-program and a second
 * program would mean a second copy of the compiler's memory with no cross-region resolution. The
 * first half was right and the second was wrong, and measuring showed why: what a program costs is
 * the *type surface it reaches*, not the files it holds, and a region reaches far less of it than a
 * repository. Measured on React — 501 MB for one whole-repository program, **69 MB** for its
 * largest region alone; `packages/react-dom` is 224 files and costs more than a 1,967-file package.
 *
 * Resolution loses nothing, because a unit's roots are not its program. Whatever those roots import
 * — a sibling package through a path mapping, a relative file in another region, a `.d.ts` under
 * `node_modules` — TypeScript's own module resolution pulls in. A frontend does not load the
 * backend's symbols because nothing in the frontend imports them; where something does, exactly
 * that arrives and nothing more.
 *
 * Each context is disposed before the next is loaded, so peak memory tracks the largest unit rather
 * than the sum. Measured across React's 113 units: peak **501 MB → 209 MB**, total time unchanged,
 * and 5 MB resident afterwards.
 *
 * **A unit that throws costs its own files and nothing else.** One region running out of memory
 * used to abort the analyser and, with it, every other region's semantics. Now it is recorded and
 * skipped, and the reason reaches the reader through capability reporting.
 *
 * Regions are attributed afterwards from `coveredFiles`, so a repository whose Python service holds
 * one stray `.ts` build script does not become a "TypeScript region" — the region's own primary
 * language decides that, and this only reports which files it read.
 */
export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly name = TYPESCRIPT_ANALYZER;

  /** Both, and for the same reason: one compiler reads them. */
  readonly languages = ['typescript', 'javascript'] as const;

  analyze(input: { readonly inventory: RepositoryInventory }): AnalyzerOutcome {
    const { inventory } = input;

    if (inventory.sourceFiles.length === 0) {
      return declined(this.name, this.languages, NOTHING_TO_READ);
    }

    const host = new ProjectHost();
    const units = planAnalysisUnits(inventory, thresholdOverrides());
    const failures: string[] = [];

    /*
     * One unit means the whole repository fitted in one program, which is every repository below
     * `DEFAULT_WHOLE_PROGRAM_LIMIT` and so the overwhelmingly common case. It needs no second pass:
     * there is no other unit for a reference to reach into, so the IR being resolved is already the
     * whole index. Kept as its own path so an ordinary repository does not load its program twice
     * to buy a ceiling it never reaches.
     */
    const single = units.length === 1 ? units[0] : undefined;

    if (single !== undefined) {
      try {
        const contribution = this.#analyzeWhole(host, inventory, single);

        return this.#outcome([contribution], units, []);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);

        return {
          analyzer: this.name,
          languages: this.languages,
          coveredFiles: [],
          depth: 'universal',
          reason: `no TypeScript or JavaScript could be compiled: ${single.id}: ${detail}`,
          contribution: null,
          failure: detail,
        };
      }
    }

    /*
     * Two passes, and the second one is what makes bounding lossless.
     *
     * A reference in one unit may reach a declaration another unit owns — a monorepo importing
     * `@traceiq/ir` is the ordinary case, not the exotic one. Resolving a unit against its own IR
     * alone put those targets outside the analysed set: measured on TraceIQ forced into bounded
     * mode, opaque IMPORTS went from 19 to **1,581** and `CALLS internal` fell 61.2% to 56.1%.
     *
     * So every unit's IR is built first, then one declaration index is built over all of it, then
     * every unit is resolved against that. The index is plain data keyed by source position, so the
     * second pass needs no compiler state from the first — which is what lets each program be
     * released as soon as its IR exists, and is why peak memory still tracks the largest unit.
     *
     * The cost is constructing each program twice. Program construction is the cheap half of a
     * bounded scan — 219 ms across TraceIQ's 32 units against 8.4 s of IR building — so the second
     * pass is a small addition to a path only large repositories take at all.
     */
    const built: { readonly unit: AnalysisUnit; readonly ir: RepositoryIR }[] = [];

    for (const unit of units) {
      try {
        built.push({ unit, ir: this.#buildIr(host, inventory, unit) });
      } catch (cause) {
        failures.push(`${unit.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    const index =
      built.length === 0
        ? null
        : DeclarationIndex.fromIr(mergeIr(built.map((entry) => entry.ir)));

    const contributions: AnalyzerContribution[] = [];

    for (const entry of built) {
      try {
        contributions.push(
          this.#resolveUnit(host, inventory, entry.unit, entry.ir, index as DeclarationIndex),
        );
      } catch (cause) {
        // One unit failing must not cost the rest their semantics. Before compilation was bounded
        // there was nothing to isolate — a throw anywhere aborted the single program and the whole
        // repository fell to discovery depth.
        failures.push(`${entry.unit.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    if (contributions.length === 0) {
      return {
        analyzer: this.name,
        languages: this.languages,
        coveredFiles: [],
        depth: 'universal',
        reason: `no TypeScript or JavaScript could be compiled: ${failures.join('; ')}`,
        contribution: null,
        failure: failures.join('; '),
      };
    }

    return this.#outcome(contributions, units, failures);
  }

  /** The outcome for a set of successful contributions, however many units produced them. */
  #outcome(
    contributions: readonly AnalyzerContribution[],
    units: readonly AnalysisUnit[],
    failures: readonly string[],
  ): AnalyzerOutcome {
    const contribution = mergeContributions(contributions);
    const hasFrameworkFacts = contribution.annotations.routes.length > 0;
    const coveredFiles = contribution.ir.files.map((file) => file.path);
    const caveat = caveatFor(units, failures);

    return {
      analyzer: this.name,
      languages: this.languages,
      coveredFiles,
      depth: hasFrameworkFacts ? 'framework' : 'semantic',
      reason: evidenceReason({
        preamble: preambleFor(coveredFiles, hasFrameworkFacts),
        contribution,
        ...(caveat === undefined ? {} : { caveat }),
      }),
      contribution,
      // Reported even though the analyser succeeded: partial success is success with something
      // missing, and a reader is owed the difference.
      failure: failures.length === 0 ? null : failures.join('; '),
    };
  }

  /** Every stage against one program, for a repository small enough to hold in one. */
  #analyzeWhole(
    host: ProjectHost,
    inventory: RepositoryInventory,
    unit: AnalysisUnit,
  ): AnalyzerContribution {
    const context = host.load({ ...inventory, sourceFiles: unit.ownedFiles });

    try {
      const ir = new IrBuilder().build(context);
      const resolved = new Resolver().resolve({ ir, context });
      const callGraph = new CallGraphResolver().resolve({ ir, resolved, context });
      const annotations = new FrameworkExtractor().extract({ ir, resolved });

      return { ir, resolved, callGraph, annotations };
    } finally {
      context.dispose();
    }
  }

  /** First pass: one unit's IR, with its program released before returning. */
  #buildIr(
    host: ProjectHost,
    inventory: RepositoryInventory,
    unit: AnalysisUnit,
  ): RepositoryIR {
    const context = host.load({ ...inventory, sourceFiles: unit.ownedFiles });

    try {
      return new IrBuilder().build(context);
    } finally {
      // Disposed in a `finally` rather than at the end, so a throw in any stage still frees the
      // program before the next unit loads one.
      context.dispose();
    }
  }

  /**
   * Second pass: resolution and the call graph, against the repository-wide declaration index.
   *
   * The IR is the one built in the first pass rather than a fresh one. Rebuilding it would be
   * wasted work and, worse, a second chance for the two to differ.
   */
  #resolveUnit(
    host: ProjectHost,
    inventory: RepositoryInventory,
    unit: AnalysisUnit,
    ir: RepositoryIR,
    index: DeclarationIndex,
  ): AnalyzerContribution {
    const context = host.load({ ...inventory, sourceFiles: unit.ownedFiles });

    try {
      const resolved = new Resolver().resolve({ ir, context, index });
      // The context is handed on so the call graph can bind through the type checker rather than by
      // name. It is still alive here — disposal happens in the `finally`, after every stage that
      // needs the compiler has run.
      const callGraph = new CallGraphResolver().resolve({ ir, resolved, context, index });
      const annotations = new FrameworkExtractor().extract({ ir, resolved });

      return { ir, resolved, callGraph, annotations };
    } finally {
      context.dispose();
    }
  }
}

/**
 * Threshold overrides from the environment, for an operator who knows their machine.
 *
 * The defaults are measured and suit an ordinary heap, but "ordinary" is the one thing a library
 * cannot know: a build agent with 64 GB should compile far more at once than a laptop, and a
 * container capped at 1 GB should compile far less. Two variables rather than a general
 * configuration object, because these are the only two numbers that decide the shape of a scan.
 *
 * An unset or unparseable value leaves the default in place. A bad number here should change
 * nothing rather than analyse a repository under a threshold nobody chose.
 */
function thresholdOverrides(): { readonly fileBudget?: number; readonly wholeProgramLimit?: number } {
  const read = (name: string): number | undefined => {
    const raw = process.env[name];
    const value = raw === undefined ? Number.NaN : Number(raw);

    return Number.isInteger(value) && value >= 0 ? value : undefined;
  };

  const fileBudget = read('TRACEIQ_FILE_BUDGET');
  const wholeProgramLimit = read('TRACEIQ_WHOLE_PROGRAM_LIMIT');

  return {
    ...(fileBudget === undefined ? {} : { fileBudget }),
    ...(wholeProgramLimit === undefined ? {} : { wholeProgramLimit }),
  };
}

/**
 * What to tell a reader about how the analysis was bounded, or `undefined` when there is nothing to
 * say.
 *
 * Two things are worth saying and neither is visible in the counts. A region split to fit the file
 * budget may leave a reference between its parts unresolved, and a unit that failed leaves its
 * files unanalysed — both are absences a reader would otherwise read as facts about the code.
 */
function caveatFor(
  units: readonly AnalysisUnit[],
  failures: readonly string[],
): string | undefined {
  const notes: string[] = [];
  const partitioned = new Set(
    units.filter((unit) => unit.partitionedFrom !== null).map((unit) => unit.partitionedFrom),
  );

  if (partitioned.size > 0) {
    notes.push(
      `${partitioned.size === 1 ? 'one region was' : `${partitioned.size} regions were`} too large to compile at once and ${partitioned.size === 1 ? 'was' : 'were'} split by directory, so a reference between two parts of ${partitioned.size === 1 ? 'it' : 'them'} is reported unresolved`,
    );
  }

  if (failures.length > 0) {
    notes.push(
      `${failures.length} of ${units.length} compilation${units.length === 1 ? '' : 's'} failed and ${failures.length === 1 ? 'its' : 'their'} files were not analysed`,
    );
  }

  return notes.length === 0 ? undefined : notes.join('; ');
}
