import type { RepositoryContext } from '@traceiq/context';

import { TIER_TOKENS, digest, estimatingCounter, type BudgetTier } from './budget.js';
import {
  IDENTIFIER_PREFIXES,
  dependencyNameOf,
  factLine,
  isEcosystemDependency,
  type ContextProjection,
  type Fact,
  type FactConfidence,
  type Omission,
  type Predicate,
} from './facts.js';
import { INTENT_PARTS, type QuestionIntent } from './intent.js';
import type { TokenCounter } from './model.js';

/**
 * `RepositoryContext` → a budgeted, citable set of facts.
 *
 * **This is the milestone.** Measured on TraceIQ itself, an `impact` context is 4.2 MB — about 1.2
 * million tokens, nine times a 128k window and 146 times an 8k one. No context kind except `file` and
 * `search` fits a large model, and none fits a local one. The Context Builder deliberately stopped short
 * of this work: choosing what fits a budget needs a tokeniser, so it belongs here.
 *
 * Four rules, each inherited from the discipline of every package below:
 *
 * 1. **Selection is by fixed priority, and ordering only ever uses a number the engine already
 *    computed.** Extractors run in a declared order and each has a declared cap per tier. No relevance
 *    score is invented here — but where a capability has already measured something, a cap must spend
 *    itself on the largest rather than on the alphabetically first.
 *
 *    This changed, and the measurement is why. `facebook/react` derives 141 packages, returned
 *    alphabetically; the first twelve are `.codesandbox/ci.json`, `.editorconfig`, `.eslintignore` and
 *    `.git-blame-ignore-revs` — single non-source files. A cap of fifteen taken off the front of that
 *    list answers "what are the main packages" with a dozen dotfiles, which is worse than answering
 *    nothing. Sorting by `declarations`, a field `PackageSummary` already carries, is not a relevance
 *    model: it is reading the number the Explorer computed instead of discarding it. Every ordering
 *    below names the field it sorts on, ties break on the identifier so two runs agree, and the fact
 *    itself carries the number so a reader can check the ordering rather than trust it.
 * 2. **Nothing is invented.** A fact restates an edge or a field the context already carried.
 * 3. **A cap is never silent.** Every extractor reports what it kept against what it had, and those
 *    omissions reach both the prompt and the caller.
 * 4. **The same context and tier produce byte-identical facts.** The property that makes everything
 *    downstream reproducible.
 *
 * The extractors read the context's **kind-independent** parts — `related`, `references`, `dependencies`,
 * `impact`, `health`, `routes`, `limitations`. That is what the Context Builder normalised them for: "a
 * consumer reads `context.references` without knowing which kind it holds." Re-deriving the same facts
 * from `primary` would duplicate assembly the layer below already did.
 */

interface Extractor {
  /** Names the context part, so an omission says where it came from. */
  readonly part: string;
  readonly caps: Readonly<Record<BudgetTier, number>>;
  /**
   * The cap this part gets in the **stable core**, where it differs from its full cap.
   *
   * Omitted means "the same either way", which is right for the small essential parts — identity,
   * composition, limitations — that every answer needs in full. It is set, and set low, for the large
   * ranked lists: the core carries enough of each to answer a general question, and the supplement
   * deepens whichever one the question is actually about.
   */
  readonly coreCaps?: Readonly<Record<BudgetTier, number>>;
  extract(context: RepositoryContext): readonly Draft[];
}

/**
 * A fact before it has an id — ids are assigned once the final order is known.
 *
 * `identities` are graph identifiers the fact **stands for without printing**. Grouping introduced the
 * need: a dependency family renders as `12 npm packages under @babel: core, parser, …`, which carries
 * every name but no `ext:` id — and the grounding guard would then have called a model's
 * `ext:npm:@babel/core` an invention, for a package the facts plainly listed. Compression must not
 * shrink what an answer is allowed to say.
 *
 * `names` is what this fact makes claimable, beyond the identifiers its subject and object carry. It
 * is declared by the extractor rather than parsed back out of the rendered object, because the object
 * is prose: a `built-with` line names a technology *and* the regions it was found in, and recovering
 * those by pattern from "React (frontend) in 48 regions including a, b, c" is the kind of guessing
 * that makes a grounding guard wrong.
 */
type Draft = Omit<Fact, 'id'> & {
  readonly names?: readonly string[];
  readonly identities?: readonly string[];
};

/**
 * Per-extractor caps, per tier.
 *
 * A cap stops one enormous part from starving every extractor after it — 900 indirect dependents would
 * otherwise consume a whole budget before the subject's own callers were reached. It is **not** the
 * primary control: the caps are set generously enough that the token budget is what usually binds, so a
 * larger context window genuinely buys more facts and a long question genuinely costs some.
 *
 * `ALL` is effectively uncapped, for parts that are both small and essential — identity, limitations, the
 * subject's condition, the impact counts. Those must never be dropped by a cap.
 */
const ALL: Readonly<Record<BudgetTier, number>> = { minimal: 1000, standard: 1000, full: 1000 };
const FEW: Readonly<Record<BudgetTier, number>> = { minimal: 3, standard: 15, full: 40 };
const SOME: Readonly<Record<BudgetTier, number>> = { minimal: 5, standard: 40, full: 200 };
const MANY: Readonly<Record<BudgetTier, number>> = { minimal: 8, standard: 100, full: 500 };

/**
 * Caps for the repository-level parts, which are the ones a cap has to *shape* rather than merely
 * bound.
 *
 * `ALL` was wrong for regions and the cost was the whole milestone's symptom. React derives 141
 * technology regions; every one produced a `region-depth` line of roughly forty tokens, so composition
 * alone asked for 5,600 of a 6,000-token budget and the projection stopped there — measured live as
 * `factCount: 66, tokens: 5450, omissions: composition kept 59 of 141`. Not one package, architecture,
 * hotspot or dependency fact was ever reached, on any question. A repository's shape is still the list
 * of its regions, but the *largest twelve* carry that shape and the omission reports the rest, which
 * is the same bargain every other extractor already makes.
 */
const REGIONS: Readonly<Record<BudgetTier, number>> = { minimal: 3, standard: 12, full: 40 };
const PACKAGES: Readonly<Record<BudgetTier, number>> = { minimal: 5, standard: 18, full: 50 };
const ARCHITECTURE: Readonly<Record<BudgetTier, number>> = { minimal: 5, standard: 24, full: 70 };
const HOTSPOTS: Readonly<Record<BudgetTier, number>> = { minimal: 4, standard: 15, full: 40 };
const TECHNOLOGIES: Readonly<Record<BudgetTier, number>> = { minimal: 6, standard: 24, full: 60 };
const DEPENDENCIES: Readonly<Record<BudgetTier, number>> = { minimal: 6, standard: 25, full: 80 };

/**
 * What each ranked list contributes to the **stable core**.
 *
 * Deliberately about a third of the full cap. The core has to be good enough that a question the
 * intent classifier gets wrong still receives a usable projection, and small enough that the
 * supplement can meaningfully deepen the part the question is about. These are the numbers that make
 * the same prefix serve "what are the packages", "what technologies", and "what are the hotspots".
 */
const CORE_PACKAGES: Readonly<Record<BudgetTier, number>> = { minimal: 3, standard: 8, full: 18 };
const CORE_ARCHITECTURE: Readonly<Record<BudgetTier, number>> = { minimal: 3, standard: 9, full: 22 };
const CORE_HOTSPOTS: Readonly<Record<BudgetTier, number>> = { minimal: 2, standard: 5, full: 12 };
const CORE_TECHNOLOGIES: Readonly<Record<BudgetTier, number>> = { minimal: 4, standard: 10, full: 24 };
const CORE_DEPENDENCIES: Readonly<Record<BudgetTier, number>> = { minimal: 3, standard: 8, full: 25 };
const CORE_REGIONS: Readonly<Record<BudgetTier, number>> = { minimal: 2, standard: 4, full: 12 };

/**
 * How much of the budget the stable core may spend.
 *
 * **The whole reason a core exists is prompt-prefix reuse, and the fraction is what makes it worth
 * having.** The provider caches the longest token prefix it has already evaluated: measured on the
 * reference stack, a repeat question reused **4,832 of 4,843** prompt tokens and answered in 19
 * seconds against 108 cold. That saving only survives if the bytes before the question are identical
 * between questions — so the core is projected from the context and the tier alone, never from the
 * question, and everything question-shaped goes after it.
 *
 * Three fifths, because the two halves fail differently. Too small a core and the cacheable prefix is
 * not worth caching; too large and the intent has no room to change anything, which is the feature.
 */
const CORE_SHARE = 0.6;

function draft(
  subject: string,
  predicate: Predicate,
  object: string,
  provenance: string,
  confidence: FactConfidence = 'CERTAIN',
): Draft {
  return { subject, predicate, object, confidence, provenance };
}

/** The graph's confidence strings arrive as plain strings through the context; narrow them safely. */
function confidenceOf(value: unknown): FactConfidence {
  return value === 'RESOLVED' || value === 'INFERRED' || value === 'AMBIGUOUS' ? value : 'CERTAIN';
}

/**
 * The subject identifier of a context, where it has one.
 *
 * A small switch on `primary` is the only place this module looks inside a capability result, and it
 * reads one field: the identity of the thing being asked about.
 */
export function subjectOf(context: RepositoryContext): string | null {
  const primary = context.primary;

  switch (primary.type) {
    case 'symbol':
      return primary.value.explain.declaration.node.id;
    case 'impact':
      return primary.value.target.node.id;
    case 'file':
      return primary.value.file.id;
    case 'package':
      return `pkg:${primary.value.name}`;
    case 'route':
      return primary.value.route.node.id;
    case 'repository':
    case 'search':
      return null;
  }
}

/**
 * Extractors, in priority order.
 *
 * The order is the design: identity first because nothing else means anything without it; limitations
 * early because they are few and they are the honesty guarantee; condition and direct relationships
 * next because they answer most questions; indirect reach and repository scale last because they are the
 * largest and the least specific.
 *
 * **The repository-level parts sit above the graph-level ones, and that ordering was measured rather
 * than assumed.** With hotspots ranked before dependencies, the budget ran out mid-hotspot on
 * `facebook/react` — `hotspots kept 14 of 120` — and every extractor after it, dependencies included,
 * contributed nothing at all. The projection therefore listed React's fourteenth most-referenced
 * declaration and none of its 333 npm packages. What a repository *depends on* answers more questions
 * than one more entry in a ranked list does, so it goes first and the ranked list absorbs the cap.
 */
const EXTRACTORS: readonly Extractor[] = [
  {
    part: 'identity',
    caps: ALL,
    extract: (context) => {
      const subject = subjectOf(context);

      if (subject === null) {
        return identityOfRepository(context);
      }

      const drafts: Draft[] = [];
      const primary = context.primary;

      if (primary.type === 'symbol') {
        const { explain } = primary.value;
        const node = explain.declaration.node;

        drafts.push(draft(subject, 'is-a', explain.kind, '@traceiq/explain'));
        drafts.push(draft(subject, 'named', node.name, '@traceiq/explain'));

        if (explain.sourceFile !== null) {
          drafts.push(draft(subject, 'declared-in', explain.sourceFile.path, '@traceiq/explain'));
        }

        const at = explain.locations[0];

        if (at !== undefined) {
          drafts.push(draft(subject, 'located-at', `${at.startLine}:${at.startColumn}`, '@traceiq/explain'));
        }

        drafts.push(draft(subject, 'exported', String(node.isExported), '@traceiq/explain'));

        if (primary.value.packageName !== null) {
          drafts.push(draft(subject, 'in-package', primary.value.packageName, '@traceiq/explorer'));
        }

        for (const role of explain.declaration.roles) {
          drafts.push(draft(subject, 'has-role', role.role, '@traceiq/framework', confidenceOf(role.confidence)));
        }
      } else if (primary.type === 'file') {
        drafts.push(draft(subject, 'is-a', 'File', '@traceiq/explorer'));
        drafts.push(draft(subject, 'in-package', primary.value.packageName, '@traceiq/explorer'));
        drafts.push(
          draft(subject, 'contains', `${primary.value.statistics.declarations} declarations`, '@traceiq/explorer'),
        );
      } else if (primary.type === 'package') {
        drafts.push(draft(subject, 'is-a', 'Package', '@traceiq/explorer'));
        drafts.push(draft(subject, 'contains', `${primary.value.statistics.files} files`, '@traceiq/explorer'));
        drafts.push(
          draft(subject, 'contains', `${primary.value.statistics.declarations} declarations`, '@traceiq/explorer'),
        );
      } else if (primary.type === 'route') {
        const { route, middleware, handler } = primary.value;

        drafts.push(draft(subject, 'is-a', 'Route', '@traceiq/query'));
        drafts.push(draft(subject, 'named', `${route.method} ${route.composition.effectivePath}`, '@traceiq/query'));

        // A prefix the extractor could not compose is reported, never guessed at. An invented effective
        // path would be the one kind of fabrication this whole layer exists to prevent.
        if (!route.composition.composed) {
          drafts.push(draft(subject, 'limitation', route.composition.note, '@traceiq/query', 'AMBIGUOUS'));
        }

        if (handler?.declaration != null) {
          drafts.push(draft(handler.declaration.id, 'handles-route', subject, '@traceiq/framework'));
        }

        for (const step of middleware) {
          if (step.declaration != null) {
            drafts.push(draft(step.declaration.id, 'route-middleware', subject, '@traceiq/framework'));
          }
        }
      } else if (primary.type === 'impact') {
        const node = primary.value.target.node;

        drafts.push(draft(subject, 'is-a', node.kind, '@traceiq/impact'));
        drafts.push(draft(subject, 'named', node.name, '@traceiq/impact'));
      }

      return drafts;
    },
  },

  /**
   * What the repository is built with, once per technology rather than once per region.
   *
   * **Deduplication is the point.** The context carries one entry per technology *per region*, which is
   * right for a view that draws a map and wrong for a budget: React reports Jest in a dozen regions,
   * and twelve near-identical `built-with` lines buy nothing a thirteenth region would not also buy.
   * Merging on name and category and naming the regions in one line says strictly more in a fraction of
   * the tokens — and it stops a repository looking as though it were built from twelve Jests.
   *
   * Ordered by how widely a technology is used, because that is the closest thing to "what is this
   * repository" that the detection actually measured. A framework found in fourteen regions is more
   * of the answer than one found in a single fixture directory.
   */
  {
    part: 'technologies',
    caps: TECHNOLOGIES,
    coreCaps: CORE_TECHNOLOGIES,
    extract: (context) => {
      interface Merged {
        readonly name: string;
        readonly category: string;
        readonly confidence: string;
        readonly regions: string[];
        readonly evidence: string;
      }

      const merged = new Map<string, Merged>();

      for (const technology of context.technologies) {
        const key = `${technology.name} :: ${technology.category}`;
        const where = technology.regionPath === '' ? 'the repository root' : technology.regionPath;
        const held = merged.get(key);

        if (held === undefined) {
          merged.set(key, {
            name: technology.name,
            category: technology.category,
            confidence: technology.confidence,
            regions: [where],
            // The first region's evidence, kept verbatim. Evidence is a sentence naming the files that
            // prove the claim, and concatenating a dozen of them would cost more than the fact.
            evidence: technology.evidence,
          });
        } else {
          held.regions.push(where);
        }
      }

      return [...merged.values()]
        .sort(
          (left, right) => right.regions.length - left.regions.length || left.name.localeCompare(right.name),
        )
        .map((entry) => ({
          // Every region this technology was found in is claimable, not merely the three the clause
          // has room to print: the model is shown "in 48 regions including a, b, c" and reasonably
          // writes about a, b and c, and reporting that as unsupported would be the guard's own fault.
          names: [entry.name, ...entry.regions],
          ...draft(
            'repository',
            'built-with',
            `${entry.name} (${entry.category})${describeRegions(entry.regions)} — ${entry.evidence}`,
            '@traceiq/technology',
            // Copied from the detection rather than fixed here. Every rule that produces one is a
            // direct reading of a manifest entry or a marker file, so these are CERTAIN — and if a
            // weaker rule is ever added, this carries its weaker confidence without a change here.
            confidenceOf(entry.confidence),
          ),
        }));
    },
  },

  /**
   * What the repository is made of, and how far analysis got with each part.
   *
   * **Second only to identity, and for the same reason limitations rank high: this is what stops the
   * model answering beyond its evidence.** Without it a projection carried no language, no region and
   * no depth, so Ask TraceIQ could not answer "what is this written in" about *any* repository, and —
   * worse — had no way to say that a Go worker's absence of callers was never measured rather than
   * measured and empty. A model with only semantic facts in front of it will describe the analysed
   * part as though it were the whole.
   *
   * Every region is emitted, never a summary: a polyglot repository's shape *is* the list, and
   * collapsing it to "polyglot" would discard the answer. Regions are few — one per dependency
   * manifest — so this stays small even for a large monorepo.
   */
  {
    part: 'composition',
    caps: ALL,
    extract: (context) => {
      const { capabilities } = context;
      const drafts: Draft[] = [];

      // One line for every language, not one line per language. Ten `written-in` facts on React cost
      // ten repetitions of the subject and the predicate to carry ten numbers; the composed form says
      // strictly more — it puts the languages in size order, which is itself the answer to "what is
      // this written in" — for about a third of the tokens. Each language stays individually claimable
      // through `names`, so grounding is unaffected.
      if (capabilities.languages.length > 0) {
        const ordered = [...capabilities.languages].sort(
          (left, right) => right.files - left.files || left.language.localeCompare(right.language),
        );

        drafts.push({
          names: ordered.map((entry) => entry.language),
          ...draft(
            'repository',
            'written-in',
            ordered.map((entry) => `${entry.language} (${entry.files})`).join(', '),
            '@traceiq/scanner',
            // Language is identified by extension. Real evidence, but not proof, and the confidence
            // says which.
            'INFERRED',
          ),
        });
      }

      drafts.push(
        draft(
          'analysis',
          'analysis-depth',
          `${capabilities.depth} is the deepest analysis reached anywhere in this repository`,
          '@traceiq/graph-api',
        ),
      );

      if (capabilities.isPolyglot) {
        drafts.push(
          draft(
            'repository',
            'is-polyglot',
            'regions of this repository carry different primary languages',
            '@traceiq/scanner',
          ),
        );
      }

      return drafts;
    },
  },

  /**
   * How deeply each part of the repository was read.
   *
   * Split out of `composition` and capped, because it is the one part whose natural size scales with
   * the repository rather than with the question — see `REGIONS`. Ordered by source file count, so a
   * cap keeps the regions that hold the code and drops the fixture directory with two files in it.
   */
  /**
   * How deeply each part of the repository was read, **grouped rather than listed**.
   *
   * React has 129 technology regions and Next.js has 688. One line each was 40 tokens apiece and
   * consumed a whole budget; capping to twelve fixed the cost and lost the shape — a reader was shown
   * a dozen paths and could not tell whether the other 117 were Python at framework depth or fixtures
   * at universal depth.
   *
   * Grouping by `(language, depth)` says both at once. Every region is accounted for in a count, the
   * largest few in each group are named so the answer can be concrete, and the group line carries the
   * total so nothing is silently dropped. On React this is 129 regions in roughly six lines instead of
   * twelve lines covering twelve regions.
   */
  {
    part: 'regions',
    caps: REGIONS,
    coreCaps: CORE_REGIONS,
    extract: (context) => {
      interface Group {
        readonly language: string;
        readonly depth: string;
        readonly paths: string[];
        files: number;
        sources: number;
        reason: string;
      }

      const groups = new Map<string, Group>();

      for (const region of context.capabilities.regions) {
        const language = region.primaryLanguage ?? 'no dominant source language';
        const identity = `${language} :: ${region.depth}`;
        const held = groups.get(identity);
        const where = region.path === '' ? 'the repository root' : region.path;

        if (held === undefined) {
          groups.set(identity, {
            language,
            depth: region.depth,
            paths: [where],
            files: region.fileCount,
            sources: region.sourceFileCount,
            reason: region.reason,
          });
        } else {
          held.paths.push(where);
          held.files += region.fileCount;
          held.sources += region.sourceFileCount;
        }
      }

      // Largest group first: the shape of a repository is what most of it is made of.
      return [...groups.values()]
        .sort((left, right) => right.sources - left.sources || left.language.localeCompare(right.language))
        .map((group) => {
          const named = [...group.paths].sort().slice(0, 3);
          const rest = group.paths.length - named.length;

          return {
            names: [...group.paths, group.language],
            ...draft(
              'analysis',
              'region-depth',
              `${group.paths.length} ${group.language} ${group.paths.length === 1 ? 'region' : 'regions'} (${group.sources} of ${group.files} files are source) analysed to ${group.depth} depth — ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}: ${group.reason}`,
              '@traceiq/graph-api',
            ),
          };
        });
    },
  },

  {
    part: 'limitations',
    caps: ALL,
    extract: (context) =>
      context.limitations.map((limitation) =>
        draft(
          'analysis',
          'limitation',
          limitation.affected === null
            ? `${limitation.code}: ${limitation.detail}`
            : `${limitation.code} (affects ${limitation.affected}): ${limitation.detail}`,
          '@traceiq/context',
          'CERTAIN',
        ),
      ),
  },

  /**
   * The units the repository is organised into, largest first.
   *
   * **This extractor is why "what are the main packages" was unanswerable.** The repository projection
   * read `overview.repository` and `overview.graph` — seven counts — and stopped, so `overview.packages`
   * reached no prompt at all and the model had no package name to give even when it wanted to. A count
   * of 141 packages is not an answer to which of them matter.
   *
   * `dependents` is carried beside the size because "biggest" and "most depended-on" are different
   * questions and a reader asking which package is important means the second at least as often as the
   * first. Both numbers are the Explorer's own.
   */
  {
    part: 'packages',
    caps: PACKAGES,
    coreCaps: CORE_PACKAGES,
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const { packages } = context.primary.value.overview;

      return [...packages.entries]
        .sort(
          (left, right) =>
            right.declarations - left.declarations ||
            right.files - left.files ||
            right.dependents - left.dependents ||
            left.name.localeCompare(right.name),
        )
        .map((entry) => ({
          names: [entry.name],
          ...draft(
            'repository',
            'has-package',
            `${entry.name} (${entry.files} ${entry.files === 1 ? 'file' : 'files'}, ${entry.declarations} declarations; imports ${entry.dependencies} packages, imported by ${entry.dependents})`,
            '@traceiq/explorer',
          ),
        }));
    },
  },

  /**
   * The repository's layers, as roles the Framework Extractor annotated.
   *
   * Counts for every role and names for the ones that describe the system. Test declarations are
   * counted and never named: React carries 6,678 of them, and a cap spent listing test functions is a
   * cap not spent on the controllers and services that answer what the code *does*.
   *
   * A role is a judgement rather than a measurement — the health layer says so in its own
   * `roles-are-judgements` limitation — so these carry the annotation's confidence unchanged.
   */
  {
    part: 'architecture',
    caps: ARCHITECTURE,
    coreCaps: CORE_ARCHITECTURE,
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const view = context.primary.value.architecture;
      const drafts: Draft[] = [];

      const layers = [
        ['Controller', view.controllers],
        ['Service', view.services],
        ['Repository', view.repositories],
        ['Middleware', view.middleware],
        ['Model', view.models],
      ] as const;

      for (const [role, listing] of layers) {
        if (listing.total > 0) {
          drafts.push(
            draft('repository', 'metric', `${listing.total} declarations carry the ${role} role`, '@traceiq/framework'),
          );
        }
      }

      if (view.tests.total > 0) {
        drafts.push(
          draft('repository', 'metric', `${view.tests.total} declarations carry the Test role`, '@traceiq/framework'),
        );
      }

      // Names after counts, so a cap that bites leaves the shape of the architecture intact even when
      // it cannot afford the membership — and one line per role rather than one per declaration, since
      // twenty `has-role` facts spent nineteen repetitions of the predicate to carry twenty names.
      for (const [role, listing] of layers) {
        for (const chunk of chunked(listing.entries, ROLE_MEMBERS_PER_FACT)) {
          drafts.push({
            names: chunk.map((node) => node.name),
            ...draft(
              'repository',
              'has-role',
              `${role}: ${chunk.map((node) => node.id).join(', ')}`,
              '@traceiq/framework',
              // The weakest confidence in the group, so a line never reads as more certain than its
              // least certain member.
              chunk.some((node) => confidenceOf(node.confidence) !== 'CERTAIN') ? 'INFERRED' : 'CERTAIN',
            ),
          });
        }
      }

      return drafts;
    },
  },

  /**
   * The repository's real dependencies, **grouped by the namespace their publisher gave them**.
   *
   * **One filter, every language.** `ext:` identities are admitted only where the kind is an ecosystem
   * and the identity carries a name — see `isEcosystemDependency`, which denies the closed set of
   * things that are not packages rather than enumerating the ecosystems that are, so npm, pip, Maven,
   * Gradle, Go modules, Cargo, NuGet, Composer and Bundler all pass and so will the tenth.
   *
   * Measured on `facebook/react`: 740 external nodes, of which 395 are `ext:builtin:*` and 11 are
   * `ext:node:*`. Before this the fifteen "dependencies" a `standard` projection showed were fifteen
   * language builtins, because the list is alphabetical and `ext:builtin:` sorts before `ext:npm:`.
   *
   * **Grouping is what turns a cap into coverage.** Twelve `@babel/*` packages spent twelve lines
   * repeating a subject, a predicate and a scope to carry twelve short names; React's real dependency
   * list is dominated by such families — `@babel`, `@jest`, `@parcel`, `org.springframework` on the JVM
   * side. One line per namespace names every member and costs a fraction, so a `standard` budget covers
   * the dependency list instead of its first alphabetical slice. A namespace is read from the package
   * name itself (`@scope/name`, `org.group:artifact`, `host.tld/owner/repo`) rather than guessed at,
   * and a package with no namespace is its own group of one.
   *
   * Ordered by family size, because a framework a repository imports from twelve times over is more of
   * the answer to "what does this depend on" than a singleton is.
   */
  {
    part: 'externalPackages',
    caps: DEPENDENCIES,
    coreCaps: CORE_DEPENDENCIES,
    extract: (context) => {
      const subject = subjectOf(context) ?? 'repository';
      const families = new Map<
        string,
        { readonly ecosystem: string; readonly members: string[]; readonly ids: string[] }
      >();

      for (const node of context.dependencies.externalPackages) {
        const name = dependencyNameOf(node.id);

        if (name === null) {
          continue;
        }

        const ecosystem = node.id.slice('ext:'.length, node.id.indexOf(':', 'ext:'.length));
        const namespace = namespaceOf(name);
        const identity = `${ecosystem} :: ${namespace}`;
        const held = families.get(identity);

        if (held === undefined) {
          families.set(identity, { ecosystem, members: [name], ids: [node.id] });
        } else {
          held.members.push(name);
          held.ids.push(node.id);
        }
      }

      return [...families.entries()]
        .sort(
          (left, right) => right[1].members.length - left[1].members.length || left[0].localeCompare(right[0]),
        )
        .map(([identity, family]) => {
          const members = [...family.members].sort();
          const namespace = identity.slice(identity.indexOf(' :: ') + 4);

          return {
            // Every member is claimable, not merely the ones a truncated line had room for — by its
            // bare name, which is how prose writes it, and by its `ext:` identity, which is how the
            // standing instruction says identifiers are spelled.
            names: [...members, namespace],
            identities: [...family.ids].sort(),
            ...draft(
              subject,
              'depends-on',
              members.length === 1
                ? `${members[0]} (${family.ecosystem})`
                : `${members.length} ${family.ecosystem} packages under ${namespace}: ${members.join(', ')}`,
              '@traceiq/resolver',
            ),
          };
        });
    },
  },

  /**
   * Where the repository is most connected.
   *
   * Answers "which modules are most important" and "what are the hotspots" with the Explorer's own
   * measurements rather than an opinion: `fanIn` is how many distinct declarations reference this one,
   * and the number travels with the fact so the ordering is checkable.
   *
   * A file nothing imports is reported as an entry point **with its ambiguity stated**. Fan-in of zero
   * over the analysed graph means one of two things — a root the repository is entered through, or code
   * nothing reaches — and the fact says both rather than picking the flattering one.
   */
  {
    part: 'hotspots',
    caps: HOTSPOTS,
    coreCaps: CORE_HOTSPOTS,
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const report = context.primary.value.hotspots;
      const drafts: Draft[] = [];

      for (const metric of report.mostReferenced.entries) {
        drafts.push(
          draft(
            metric.node.id,
            'hotspot',
            `referenced by ${metric.fanIn} distinct declarations`,
            '@traceiq/explorer',
          ),
        );
      }

      for (const metric of report.mostConnectedFiles.entries) {
        drafts.push(
          draft(
            metric.node.id,
            metric.fanIn === 0 ? 'entry-point' : 'hotspot',
            metric.fanIn === 0
              ? `no analysed file imports it, and it reaches ${metric.fanOut} — either a root the repository is entered through or code nothing reaches`
              : `imported by ${metric.fanIn} files and imports ${metric.fanOut}`,
            '@traceiq/explorer',
          ),
        );
      }

      return drafts;
    },
  },

  {
    part: 'health',
    caps: ALL,
    extract: (context) => {
      const subject = subjectOf(context) ?? 'repository';
      const condition = context.health.subject;

      if (condition === null) {
        return repositoryHealth(context);
      }

      const drafts: Draft[] = [
        draft(subject, 'fan-in', String(condition.fanIn), '@traceiq/health'),
        draft(subject, 'fan-out', String(condition.fanOut), '@traceiq/health'),
      ];

      if (condition.isolated) {
        drafts.push(draft(subject, 'isolated', 'true', '@traceiq/health'));
      }

      if (condition.inCycle) {
        drafts.push(draft(subject, 'in-cycle', 'true', '@traceiq/health'));
      }

      if (condition.recursive) {
        drafts.push(draft(subject, 'recursive', 'true', '@traceiq/health'));
      }

      for (const finding of condition.findings) {
        drafts.push(draft(subject, 'finding', finding, '@traceiq/health'));
      }

      return drafts;
    },
  },

  {
    part: 'impact-summary',
    caps: ALL,
    extract: (context) => {
      const summary = context.impact.summary;

      if (summary === null) {
        return [];
      }

      const subject = subjectOf(context) ?? 'repository';

      // Counts, in the analyser's own categories. DIRECT, INDIRECT and UNKNOWN are never merged: a direct
      // dependent breaks when a signature changes, an indirect one only might, and UNKNOWN is impact that
      // could not be determined rather than impact that is absent.
      return [
        draft(subject, 'affects-directly', `${summary.directlyAffected} declarations`, '@traceiq/impact'),
        draft(subject, 'affects-indirectly', `${summary.indirectlyAffected} declarations`, '@traceiq/impact'),
        draft(subject, 'unresolved', `${summary.unknown} relationships could not be bound`, '@traceiq/impact'),
        draft(subject, 'affects-route', `${summary.routesAffected} routes`, '@traceiq/impact'),
      ];
    },
  },

  {
    part: 'incomingCalls',
    caps: SOME,
    extract: (context) =>
      context.references.incomingCalls.flatMap((reference) => {
        const source = reference.source;

        return source === null
          ? []
          : [draft(source.id, 'calls', subjectOf(context) ?? '', '@traceiq/call-graph', confidenceOf(reference.edge.confidence))];
      }),
  },

  {
    part: 'outgoingCalls',
    caps: SOME,
    extract: (context) =>
      context.references.outgoingCalls.flatMap((callee) => {
        const target = callee.target;

        return target === null
          ? []
          : [draft(subjectOf(context) ?? '', 'calls', target.id, '@traceiq/call-graph', confidenceOf(callee.edge.confidence))];
      }),
  },

  {
    part: 'references',
    caps: SOME,
    extract: (context) =>
      context.references.references.flatMap((reference) => {
        const source = reference.source;

        return source === null
          ? []
          : [
              draft(
                source.id,
                'references',
                subjectOf(context) ?? '',
                '@traceiq/resolver',
                confidenceOf(reference.edge.confidence),
              ),
            ];
      }),
  },

  {
    part: 'typeReferences',
    caps: FEW,
    extract: (context) =>
      context.references.typeReferences.flatMap((reference) => {
        const source = reference.source;

        return source === null
          ? []
          : [
              draft(
                source.id,
                'references-type',
                subjectOf(context) ?? '',
                '@traceiq/resolver',
                confidenceOf(reference.edge.confidence),
              ),
            ];
      }),
  },

  {
    part: 'related',
    caps: MANY,
    extract: (context) => {
      const subject = subjectOf(context) ?? 'repository';

      return context.related.map((entry) => {
        const predicate = RELATION_PREDICATE[entry.relation] ?? 'references';
        const depth = entry.depth === null ? '' : ` at depth ${entry.depth}`;

        // The relation is the capability's own word for how this node reaches the subject. It is carried
        // through rather than re-derived, so a fact cannot disagree with the context that produced it.
        return REVERSED.has(entry.relation)
          ? draft(entry.node.id, predicate, `${subject}${depth}`, '@traceiq/context', confidenceOf(entry.node.confidence))
          : draft(subject, predicate, `${entry.node.id}${depth}`, '@traceiq/context', confidenceOf(entry.node.confidence));
      });
    },
  },

  {
    part: 'environmentVariables',
    caps: FEW,
    extract: (context) => {
      const subject = subjectOf(context) ?? 'repository';

      return context.dependencies.environmentVariables.map((node) =>
        draft(subject, 'reads-env', node.name, '@traceiq/framework'),
      );
    },
  },

  {
    part: 'routes',
    caps: FEW,
    extract: (context) =>
      context.routes.map((route) =>
        draft(route.node.id, 'handles-route', `${route.method} ${route.composition.effectivePath}`, '@traceiq/framework'),
      ),
  },

  {
    part: 'dependencyClosure',
    caps: SOME,
    extract: (context) => {
      const view = context.dependencies.view;

      if (view === null) {
        return [];
      }

      const subject = subjectOf(context) ?? 'repository';

      // The explorer separates what the subject reaches from what reaches it, and reports the shortest
      // depth for each. Both directions are carried, because "what breaks if I change this" and "what
      // does this rely on" are different questions and merging them would answer neither.
      return [
        ...view.indirect.forward.entries.map((reached) =>
          draft(subject, 'depends-on', `${reached.node.id} at depth ${reached.depth}`, '@traceiq/explorer'),
        ),
        ...view.indirect.reverse.entries.map((reached) =>
          draft(reached.node.id, 'depends-on', `${subject} at depth ${reached.depth}`, '@traceiq/explorer'),
        ),
      ];
    },
  },

  {
    part: 'cycles',
    caps: FEW,
    extract: (context) => {
      const report = context.dependencies.cycles;

      if (report === null) {
        return [];
      }

      const drafts: Draft[] = [];

      for (const [name, listing] of [
        ['import', report.importCycles],
        ['call', report.callCycles],
      ] as const) {
        for (const cycle of listing.entries) {
          drafts.push(
            draft(
              'repository',
              'cycle-member',
              `${name} cycle of ${cycle.nodes.length}: ${cycle.nodes.map((node) => node.id).join(' → ')}`,
              '@traceiq/explorer',
            ),
          );
        }
      }

      return drafts;
    },
  },
];

const RELATION_PREDICATE: Readonly<Record<string, Predicate>> = {
  enclosing: 'enclosed-by',
  child: 'encloses',
  caller: 'calls',
  callee: 'calls',
  'type-reference': 'references-type',
  declaration: 'contains',
  'package-file': 'contains',
  handler: 'handles-route',
  middleware: 'route-middleware',
  affected: 'affects-directly',
  'search-result': 'named',
};

/** Relations whose natural reading puts the related node first. */
const REVERSED = new Set(['caller', 'type-reference', 'affected', 'handler', 'middleware', 'enclosing']);

/**
 * How many role members one fact names.
 *
 * A line has to stay readable and, more importantly, citable: a model asked to attribute a claim to
 * `[f31]` should be pointing at a handful of declarations rather than at forty. Six is small enough to
 * quote back in a sentence and large enough to remove most of the repetition.
 */
const ROLE_MEMBERS_PER_FACT = 6;

/** Splits a list into fixed-size runs, preserving order. */
function chunked<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

/**
 * The namespace a package name carries, or the name itself when it carries none.
 *
 * Read from the three shapes publishers actually use — an npm scope (`@babel/core`), a JVM group
 * (`org.springframework:spring-core`, and the dotted package form Java imports use), and a Go module
 * host (`github.com/gin-gonic/gin`). Nothing is inferred beyond splitting on the separator the
 * ecosystem itself defined.
 */
function namespaceOf(name: string): string {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');

    return slash === -1 ? name : name.slice(0, slash);
  }

  const colon = name.indexOf(':');

  if (colon > 0) {
    return name.slice(0, colon);
  }

  if (name.includes('/')) {
    // A Go module path: host plus owner is the family, the repository is the member.
    return name.split('/').slice(0, 2).join('/');
  }

  const dotted = name.split('.');

  // A dotted Java package: everything but the last segment is the namespace, and a bare name is not
  // dotted at all so it becomes its own group.
  return dotted.length > 2 ? dotted.slice(0, -1).join('.') : name;
}

/**
 * Whether a fact is worth a token at all.
 *
 * **One filter, applied to every extractor, so a language builtin cannot reach the prompt by any
 * route.** Filtering only the dependency extractor left three other doors open — a call edge to
 * `ext:builtin:Promise`, a dependency closure entry for `ext:node:fs`, a related node that is a
 * compiler intrinsic — and each of them spends budget teaching a model that JavaScript has promises.
 *
 * Measured on `facebook/react`: 395 of 740 external nodes are `ext:builtin:*` and 11 are `ext:node:*`,
 * so more than half of everything the graph records as external is a language construct rather than
 * anything about this repository.
 *
 * The rule reads the identity the graph already assigned rather than re-deciding anything; see
 * `isEcosystemDependency` for why it denies a closed set of non-package kinds instead of listing the
 * ecosystems, and therefore admits an ecosystem nobody has added yet.
 */
function admissible(candidate: Draft): boolean {
  for (const value of [candidate.subject, candidate.object]) {
    // The depth suffix is part of the edge, not the name — see the identifier set built in `project`.
    const bare = value.replace(/ at depth \d+$/, '');

    if (bare.startsWith('ext:') && !isEcosystemDependency(bare)) {
      return false;
    }
  }

  return true;
}

/**
 * Where a technology was found, in one clause.
 *
 * Three regions are named; beyond that the count replaces the list, because the point of the clause is
 * *how widely* something is used and forty paths do not say that better than "in 40 regions" does.
 */
function describeRegions(regions: readonly string[]): string {
  if (regions.length === 0) {
    return '';
  }

  if (regions.length <= 3) {
    return ` in ${regions.join(', ')}`;
  }

  return ` in ${regions.length} regions including ${regions.slice(0, 3).join(', ')}`;
}

function identityOfRepository(context: RepositoryContext): readonly Draft[] {
  if (context.primary.type === 'repository') {
    const { overview } = context.primary.value;

    return [
      draft('repository', 'is-a', 'Repository', '@traceiq/explorer'),
      draft('repository', 'contains', `${overview.repository.files} files`, '@traceiq/explorer'),
      draft('repository', 'contains', `${overview.repository.declarations} declarations`, '@traceiq/explorer'),
      draft('repository', 'contains', `${overview.repository.routes} routes`, '@traceiq/explorer'),
      draft('repository', 'metric', `${overview.graph.nodes} graph nodes`, '@traceiq/graph-api'),
      draft('repository', 'metric', `${overview.graph.edges} graph edges`, '@traceiq/graph-api'),
      draft(
        'repository',
        'metric',
        `${overview.graph.unresolvedReferences} unresolved references`,
        '@traceiq/graph-api',
      ),
    ];
  }

  if (context.primary.type === 'search') {
    const results = context.primary.value;

    return [
      draft('search', 'is-a', 'SearchResults', '@traceiq/explorer'),
      draft('search', 'metric', `${results.total} matches, ${results.match} matching`, '@traceiq/explorer'),
    ];
  }

  return [];
}

function repositoryHealth(context: RepositoryContext): readonly Draft[] {
  const report = context.health.report;

  if (report === null) {
    return [];
  }

  const drafts: Draft[] = [
    draft('repository', 'metric', `call graph coverage ${report.callGraphHealth.coverage.toFixed(3)}`, '@traceiq/health'),
    draft('repository', 'metric', `max call depth ${report.callGraphHealth.maxCallDepth}`, '@traceiq/health'),
    draft(
      'repository',
      'metric',
      `${report.callGraphHealth.declarationsInCycles} declarations in cycles`,
      '@traceiq/health',
    ),
    draft('repository', 'metric', `${report.dependencyHealth.isolated.count} isolated declarations`, '@traceiq/health'),
  ];

  // Findings are grouped by code with a count rather than listed per node: the node lists run to hundreds
  // of entries and the code plus its size is what answers a question about repository condition.
  const byCode = new Map<string, number>();

  for (const finding of report.findings) {
    byCode.set(finding.code, (byCode.get(finding.code) ?? 0) + finding.nodeCount);
  }

  for (const [code, total] of [...byCode.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )) {
    drafts.push(draft('repository', 'finding', `${code} (${total} nodes)`, '@traceiq/health'));
  }

  return drafts;
}

export interface ProjectionOptions {
  readonly tier: BudgetTier;
  /** Tokens already spent on the fixed prompt scaffolding and the question. */
  readonly reserved?: number;
  readonly counter?: TokenCounter;
  /**
   * What the question is about. Decides the **supplement** only; the core is identical either way.
   *
   * Omitted means `overview`, the balanced projection — which is also what a caller inspecting a
   * projection without a question in hand should see.
   */
  readonly intent?: QuestionIntent;
}

/**
 * Projects a context into a budget.
 *
 * One pass in extractor order. Each extractor's drafts are capped at its per-tier limit, then admitted
 * one at a time while the budget lasts. Both the cap and the budget produce a recorded omission, so
 * `kept` versus `total` is always the truth about what the model was shown.
 */
export function project(context: RepositoryContext, options: ProjectionOptions): ContextProjection {
  const counter = options.counter ?? estimatingCounter;
  const budget = TIER_TOKENS[options.tier] - (options.reserved ?? 0);
  const intent = options.intent ?? 'overview';

  const facts: Fact[] = [];
  const lines: string[] = [];

  /** Kept and available per part, merged across both passes so one part reports one omission. */
  const tally = new Map<string, { kept: number; total: number }>();

  let spent = 0;
  let sequence = 0;

  /** Names declared by the facts that were actually admitted. See `termsFrom`. */
  const claimed: string[] = [];

  /** Graph identifiers admitted facts stand for without printing. See `Draft.identities`. */
  const represented: string[] = [];

  /**
   * Facts already emitted, by triple.
   *
   * **The context mirrors some edges deliberately** — `references` is documented as "a kind-independent
   * view, not additional data", so a type reference appears both there and under `related`. Emitting both
   * spent 40 of a symbol projection's 276 facts on exact duplicates: budget paid twice, and apparent
   * evidence inflated. Deduplication is by (subject, predicate, object), and the earlier — higher
   * priority — extractor wins.
   *
   * **It records what was *emitted*, never what was offered**, and the difference is what makes two
   * passes work at all. A first version marked every draft an extractor produced, so the core pass —
   * which sees all sixty technologies and can afford four — retired the other fifty-six as "already
   * said". The supplement then found nothing left anywhere and the intent could change nothing. A fact
   * a budget could not afford has not been said.
   */
  const seen = new Set<string>();
  const key = (fact: Draft): string => `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`;

  /**
   * Runs one pass over a list of extractors, admitting what fits.
   *
   * Returns `false` once the pass's own ceiling is reached, so the caller can stop rather than keep
   * calling extractors whose output cannot be afforded.
   */
  const run = (extractors: readonly Extractor[], ceiling: number, core: boolean): void => {
    for (const extractor of extractors) {
      // Filtering before capping keeps the omission honest: `total` counts the facts this part could
      // have contributed that nothing earlier had already said *and* that are worth a token.
      // Duplicates *within* one extractor's output are dropped here; duplicates against what earlier
      // extractors emitted are dropped against `seen`, which only holds facts that were admitted.
      const offered = new Set<string>();
      const drafts = extractor.extract(context).filter((candidate) => {
        if (!admissible(candidate)) {
          return false;
        }

        const identity = key(candidate);

        if (seen.has(identity) || offered.has(identity)) {
          return false;
        }

        offered.add(identity);

        return true;
      });

      if (drafts.length === 0) {
        continue;
      }

      const caps = core ? (extractor.coreCaps ?? extractor.caps) : extractor.caps;
      const capped = drafts.slice(0, caps[options.tier]);
      let kept = 0;

      for (const candidate of capped) {
        sequence += 1;
        const fact: Fact = { ...candidate, id: `f${sequence}` };
        const line = factLine(fact);
        const cost = counter.count(line);

        if (spent + cost > ceiling) {
          // This pass is exhausted. Undo the candidate's id so numbering stays contiguous, and stop —
          // admitting later, cheaper facts out of order would break the fixed priority.
          sequence -= 1;
          break;
        }

        seen.add(key(candidate));
        facts.push(fact);
        claimed.push(...(candidate.names ?? []));
        represented.push(...(candidate.identities ?? []));
        lines.push(line);
        spent += cost;
        kept += 1;
      }

      const held = tally.get(extractor.part) ?? { kept: 0, total: 0 };

      // `total` is the largest this part was ever seen to offer. Both passes see the same context, but
      // the second sees fewer candidates because the first consumed some — summing would double-count.
      tally.set(extractor.part, { kept: held.kept + kept, total: Math.max(held.total, held.kept + drafts.length) });

      if (kept < capped.length) {
        // Nothing later in this pass can fit either, since every extractor after it is lower priority.
        return;
      }
    }
  };

  // Pass one: the stable core. Extractor order, core caps, and a fixed share of the budget — nothing
  // here reads the question, which is precisely what lets the rendered prefix be reused between them.
  run(EXTRACTORS, Math.floor(budget * CORE_SHARE), true);

  /**
   * The boundary, recorded here rather than re-derived afterwards.
   *
   * A first version counted forward through the rendered lines until the core's token ceiling was
   * reached, which is wrong whenever the whole projection costs less than that ceiling: every
   * supplement fact then fell inside the "stable" prefix, and the prefix stopped being stable the
   * moment the question changed. The boundary is a fact of the pass, so the pass is what states it.
   */
  const coreCount = facts.length;

  // Pass two: the supplement, led by whatever the question is about.
  run(orderedFor(intent), budget, false);

  const omissions: Omission[] = [...tally.entries()]
    .filter(([, counts]) => counts.kept < counts.total)
    .map(([part, counts]) => ({ part, kept: counts.kept, total: counts.total }));

  // The closed set the grounding guard checks against. It holds **identifiers only**: an object may read
  // `sym:… at depth 2`, and the depth is a fact about the edge rather than part of the name, so it is
  // stripped. Leaving it attached would put a string that is not an identifier into a set of identifiers,
  // and a model citing the name alone would be accused of inventing it.
  const identifiers = new Set<string>(represented);

  for (const fact of facts) {
    for (const value of [fact.subject, fact.object]) {
      const bare = value.replace(/ at depth \d+$/, '');

      if (IDENTIFIER_PREFIXES.some((prefix) => bare.startsWith(prefix))) {
        identifiers.add(bare);
      }
    }
  }

  return {
    kind: context.kind,
    subject: subjectOf(context),
    facts,
    coreCount,
    intent,
    identifiers,
    terms: termsFrom(facts, [...claimed, ...represented]),
    omissions,
    tier: options.tier,
    tokens: spent,
    digest: digest(lines),
  };
}

/**
 * Extractors with the ones this question is about brought to the front.
 *
 * A **reordering, never a filter**: every extractor still runs, so an intent the classifier got wrong
 * costs a differently-ordered supplement rather than a missing part of the repository. That property is
 * what lets the classifier be six lines of keyword matching instead of a second model call.
 */
function orderedFor(intent: QuestionIntent): readonly Extractor[] {
  const wanted = INTENT_PARTS[intent];

  if (wanted.length === 0) {
    return EXTRACTORS;
  }

  const rank = (extractor: Extractor): number => {
    const index = wanted.indexOf(extractor.part);

    return index === -1 ? wanted.length : index;
  };

  // A stable sort, so parts the intent does not name keep their declared order behind the ones it does.
  return [...EXTRACTORS].sort((left, right) => rank(left) - rank(right));
}

/**
 * The closed set of *names* an answer may claim, beyond the graph's own identifiers.
 *
 * **Derived from the facts that were actually admitted, never from the context.** A name the budget
 * cut is a name the model was not shown, and putting it in the permitted set would let a fabrication
 * pass because the projection happened to know it. The set therefore shrinks with the budget exactly
 * as the identifier set does.
 *
 * Three sources:
 *
 * - **`claimed`** — names an extractor declared for a fact it emitted: the technology and every region
 *   it was found in, the package name, the region path, the language. Declared rather than parsed back
 *   out of the rendered object, because the object is prose.
 * - **A dependency identity**, reduced to the package name and its last segment, so an answer that
 *   writes `react-dom` rather than `ext:npm:react-dom` is still checkable.
 * - **Every identifier**, plus the file path and declaration chain inside it. This last part matters
 *   more than it looks: a first attempt recorded only whole identifiers, and a correct answer about
 *   React was marked ungrounded for saying "Fiber in packages/react-reconciler/src/ReactInternalTypes.js"
 *   — both halves of which the facts plainly carried. A guard that is wrong about a right answer is
 *   worse than no guard.
 */
function termsFrom(facts: readonly Fact[], claimed: readonly string[]): ReadonlySet<string> {
  const terms = new Set<string>();

  const add = (value: string): void => {
    const trimmed = value.trim().toLowerCase();

    if (trimmed !== '') {
      terms.add(trimmed);
    }
  };

  for (const name of claimed) {
    add(name);

    // A namespaced name is also written by its last segment — `@babel/core` as `core`,
    // `org.springframework:spring-core` as `spring-core`, `github.com/gin-gonic/gin` as `gin`. Prose
    // does this constantly, and compression made it more likely by printing families rather than ids.
    //
    // Widening the permitted set can only ever make the guard *more* permissive, never wrong: a term
    // it admits is one it will not accuse. The asymmetry is deliberate — the cost of missing a
    // fabrication is one unflagged sentence, and the cost of a false accusation is a correct answer
    // presented to a user as untrustworthy.
    const tail = name.split(/[/:]/).at(-1);

    if (tail !== undefined && tail !== name) {
      add(tail);
    }
  }

  for (const fact of facts) {
    if (fact.predicate === 'depends-on') {
      const object = (fact.object.split(' (')[0] ?? fact.object).trim();
      const name = dependencyNameOf(object.replace(/ at depth \d+$/, ''));

      if (name !== null) {
        add(name);
        // A scoped or coordinate name is also written as its last segment in prose —
        // `@babel/core` as `core`, `org.springframework:spring-core` as `spring-core`.
        const tail = name.split(/[/:]/).at(-1);

        if (tail !== undefined) {
          add(tail);
        }
      }
    }

    for (const value of [fact.subject, fact.object]) {
      if (!IDENTIFIER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
        continue;
      }

      const bare = value.replace(/ at depth \d+$/, '');

      add(bare);

      // The file a declaration lives in, written as prose writes it. A model shown
      // `sym:packages/react-reconciler/src/ReactInternalTypes.js#Fiber` refers to it as
      // "Fiber in packages/react-reconciler/src/ReactInternalTypes.js", and neither half of that
      // sentence should be reported as an invention.
      const body = bare.slice(bare.indexOf(':') + 1);
      const [path, chain] = body.split('#');

      if (path !== undefined) {
        add(path);
      }

      if (chain !== undefined) {
        add(chain);
        add(chain.split('.').at(-1) ?? '');
      }
    }
  }

  return terms;
}
