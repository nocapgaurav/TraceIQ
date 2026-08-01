import type { CallGraph } from '@traceiq/call-graph';
import type { FrameworkAnnotations } from '@traceiq/framework';
import type { AnalysisDepth } from '@traceiq/graph-api';
import type { RepositoryIR } from '@traceiq/ir';
import type { ResolvedRepository } from '@traceiq/resolver';
import type { RepositoryInventory } from '@traceiq/scanner';

/**
 * What a language analyser contributes to the repository graph.
 *
 * **This is the whole contract, and it is deliberately not new vocabulary.** `RepositoryIR`,
 * `ResolvedRepository`, `CallGraph` and `FrameworkAnnotations` were already plain data with no
 * compiler type in them — the TypeScript analyser happens to build them with ts-morph, but nothing
 * in their shape says so. A Python or Go analyser fills in the same four structures from its own
 * parser, and every downstream package reads the result without knowing which language produced it.
 *
 * An analyser emits only what its language actually has. Go has no classes, so a Go analyser emits
 * no `class` declarations; that is an absence, not a gap to be filled with an approximation.
 *
 * ## The semantic contract
 *
 * Every analyser is expected to produce each of the following **where the language has it**, and to
 * be silent where it does not. The distinction between "absent from the language" and "absent from
 * the analyser" is what the capability reason exists to state, and an analyser that quietly skips a
 * construct its language *does* have is the failure mode this list is written against.
 *
 * | Fact | Structure | Absent only when |
 * |---|---|---|
 * | declarations | `ir.declarations` | never — every language declares something |
 * | imports | `ir.imports` + `IMPORTS` | never |
 * | exports | `ir.exports` + `EXPORTS` | the language has no export statement (Python, Go) |
 * | inheritance | `EXTENDS` | the language has no inheritance |
 * | implementation | `IMPLEMENTS` | the language has no separate interface implementation (Python, Go) |
 * | dependencies | `IMPORTS` onto an external | never |
 * | internal calls | `callGraph.calls` | never |
 * | external calls | `callGraph.externalCalls` | never |
 * | unresolved calls | `callGraph.unresolved` | never — an unbindable call must be visible |
 * | confidence | every edge | never |
 * | evidence | every provenance | never |
 * | source ranges | every `location` | never |
 *
 * **`externalCalls` was the row that was not being honoured.** Three of the five analysers returned
 * it empty, so a Java, Go or Python reader could see the dependencies a manifest *declared* and
 * never the ones a declaration actually *called* — while TypeScript reported 12,851 such edges for
 * this repository alone. It is not a checker-only fact: an import statement names where a call
 * goes, which every analyser can read.
 *
 * ## Confidence is per rule, not per language
 *
 * An analyser states how strong each of its own rules is, and the levels mean the same thing
 * everywhere. Go reaches `RESOLVED` on imports and package-qualified calls because a Go import path
 * is the module path plus a directory with no search involved; Java never does on a call, because
 * Java dispatches on the runtime type and no classpath was opened. Neither is a statement about how
 * good the analyser is — both are statements about what the language proves.
 */
export interface AnalyzerContribution {
  readonly ir: RepositoryIR;
  readonly resolved: ResolvedRepository;
  readonly callGraph: CallGraph;
  readonly annotations: FrameworkAnnotations;
}

/**
 * One analyser's run over a repository: what it covered, how deep it got, and whether it failed.
 *
 * `coveredFiles` is what makes capability honest. Depth is not claimed for a repository or guessed
 * from a region's language — it is derived from the files an analyser actually read. A region whose
 * files appear in no analyser's coverage stays at `universal`, whatever language it is written in.
 */
export interface AnalyzerOutcome {
  /** The analyser's name, recorded as the producer of every fact it contributed. */
  readonly analyzer: string;
  /**
   * The region primary languages this analyser claims, copied from the analyser.
   *
   * Carried on the outcome so that a region left uncovered can be explained: a *claimed* language
   * left uncovered means the analyser failed, while an unclaimed one simply has no analyser yet.
   * Those are different facts and a reader needs to be told which.
   */
  readonly languages: readonly string[];
  /** Repository-relative paths this analyser read. Empty when it declined or failed. */
  readonly coveredFiles: readonly string[];
  /** The deepest analysis achieved for those files. */
  readonly depth: AnalysisDepth;
  /** Fixed text explaining that depth, shown to a reader unchanged. */
  readonly reason: string;
  /** `null` when the analyser declined — no files of its language — or threw. */
  readonly contribution: AnalyzerContribution | null;
  /**
   * The message from a thrown analyser, or `null`.
   *
   * Recorded rather than propagated. One analyser failing must not cost a polyglot repository the
   * regions its other analysers handled successfully, so a failure becomes a fact about one region
   * instead of an error about the whole scan.
   */
  readonly failure: string | null;
}

/**
 * A language analyser.
 *
 * Given the whole inventory rather than one region, deliberately. The TypeScript analyser must load
 * exactly one compiler program for the repository — its type checker is whole-program, and splitting
 * it per region would mean several copies of the compiler's memory and a checker that cannot see
 * across a monorepo's package boundaries. An analyser therefore reads everything of its language at
 * once and reports what it covered; regions are attributed from that coverage afterwards.
 *
 * `analyze` may throw. The runner catches it — see `AnalyzerOutcome.failure`.
 */
export interface LanguageAnalyzer {
  readonly name: string;
  /**
   * The region primary languages this analyser claims, as `LanguageName` values.
   *
   * Used to decide which regions it is *expected* to cover, so that a region of a claimed language
   * left uncovered is reported as a failure rather than as silence.
   */
  readonly languages: readonly string[];

  analyze(input: { readonly inventory: RepositoryInventory }): AnalyzerOutcome;
}

/** An analyser that read nothing, because the repository holds no files of its language. */
export function declined(
  analyzer: string,
  languages: readonly string[],
  reason: string,
): AnalyzerOutcome {
  return {
    analyzer,
    languages,
    coveredFiles: [],
    depth: 'universal',
    reason,
    contribution: null,
    failure: null,
  };
}

/**
 * An analyser whose contribution the graph refused.
 *
 * Distinct from `declined` and from a thrown analyser: this one ran, returned, and produced facts the
 * graph could not accept — a duplicate identifier, an edge the endpoint matrix forbids. The analyser
 * did not fail so much as its output did, and the outcome must say so, because the region it covered
 * has to fall back to `universal` depth rather than keep claiming a depth whose evidence was dropped.
 */
export function rejected(outcome: AnalyzerOutcome, failure: string): AnalyzerOutcome {
  return {
    analyzer: outcome.analyzer,
    languages: outcome.languages,
    coveredFiles: [],
    depth: 'universal',
    reason: `the ${outcome.analyzer} analyser produced facts the graph could not accept, so this region was left at discovery depth — ${failure}`,
    contribution: null,
    failure,
  };
}
