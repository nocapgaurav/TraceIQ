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
import type { FactAllocation, FactGroup } from './plan.js';
import { responsibilityOf, summariseArchitecture, type TechnologyRef } from './architecture.js';
import { deriveProfile, type RepositoryProfile } from './profile.js';
import { deriveIdentity } from './identity.js';
import { renderWorkflow } from './workflow.js';
import { deriveStructure, roleOfPath } from './structure.js';
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
  /**
   * What *kind of thing* this repository is, before anything about it is described.
   *
   * **First, ahead even of the architecture summary, and for the same reason that one is ahead of the
   * counts.** The summary says what the system contains; this says what it *is*, which is the sentence
   * the prompt's whole explanation strategy is built around. A model instructed to explain a framework's
   * extension points, and given no fact saying this repository is a framework, would either write the
   * claim uncited — which the standing instruction forbids — or hedge its way around the one thing it
   * was most confidently told.
   *
   * Three facts at most, each carrying the evidence the profile derived it from, so a reader can check
   * the characterisation rather than trust it. Everything else in the profile is a restatement of facts
   * emitted below and would be paid for twice.
   */
  {
    part: 'profile',
    caps: ALL,
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const profile = deriveProfile(context);
      const drafts: Draft[] = [];

      if (profile.type.value !== 'unknown') {
        drafts.push({
          names: [profile.type.value],
          ...draft(
            'repository',
            'characterised-as',
            `a ${profile.type.value} — ${profile.type.evidence.join('; ')}`,
            '@traceiq/ai',
            // Derived from graph evidence by rule, not measured. The same honesty `layered` observes:
            // that a repository exposes routes is CERTAIN, that this makes it a service is a judgement.
            'INFERRED',
          ),
        });
      }

      /*
       * The scale, stated as what it *means for an answer* rather than as a file count.
       *
       * A model told "1,347 files" will report 1,347 files. Told that the repository is too large to
       * describe at once and that these are its largest units, it has been given the shape of the
       * answer instead of another number to repeat — and the numbers are still there, at the end, as
       * the evidence for the claim.
       */
      drafts.push({
        names: profile.units.slice(0, 6),
        ...draft(
          'repository',
          'characterised-as',
          `${profile.scale.scale} — ${profile.scale.files} files, ${profile.scale.declarations} declarations, ${profile.scale.packages} packages${
            profile.units.length === 0 ? '' : `; largest units ${profile.units.slice(0, 6).join(', ')}`
          }`,
          '@traceiq/explorer',
        ),
      });

      if (profile.domains.length > 0) {
        drafts.push({
          ...draft(
            'repository',
            'characterised-as',
            `organised around ${profile.domains
              .slice(0, 5)
              .map((claim) => `${claim.domain} (${claim.evidence[0] ?? ''})`)
              .join(', ')}`,
            '@traceiq/ai',
            'INFERRED',
          ),
        });
      }

      return drafts;
    },
  },

  /**
   * What the repository is *for*, what happens when it works, and what matters most in it.
   *
   * **Second only to the profile, and ahead of every structural fact, because this is the answer's
   * opening sentence.** The profile says what kind of thing the repository is; these say what it is
   * trying to accomplish. A model given the guidance "this repository is organised around url and
   * analytics" and no fact carrying it must either write the sentence uncited — which the standing
   * instruction forbids — or hedge around the one thing it was told most confidently.
   *
   * Every line here **reorganises** evidence emitted below rather than measuring anything new: the
   * purpose is assembled from the type rules and the layer agreement, a workflow is the framework
   * extractor's own route-to-handler edges arranged as a sequence, and a rank carries the fan-in the
   * health analyser already computed. That is why the cap is small — the budget should be spent on the
   * evidence, not on a second rendering of it.
   */
  {
    // `identity` is already taken, by the extractor that states what the *subject* of a context is.
    // This one is about the repository's purpose, so it is named for that rather than renaming a part
    // that appears in recorded omissions.
    part: 'purpose',
    caps: { minimal: 3, standard: 8, full: 14 },
    coreCaps: { minimal: 2, standard: 6, full: 10 },
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const identity = deriveIdentity(context);
      const drafts: Draft[] = [];

      if (identity.purpose !== null) {
        drafts.push({
          ...draft(
            'repository',
            'exists-to',
            `${identity.purpose.value} — ${identity.purpose.evidence.slice(0, 2).join('; ')}`,
            '@traceiq/ai',
            // Assembled from evidenced clauses by rule. That the repository exposes `/:shortCode` is
            // measured; that this makes it "organised around url" is a derivation, and says so.
            'INFERRED',
          ),
        });
      }

      /*
       * The workflows, which are the facts nothing else in this projection can express.
       *
       * A `request-flow` fact already names the layers a request conventionally traverses. A workflow
       * names *this* route reaching *this* handler, which is an edge the framework extractor recorded
       * — so the two are not duplicates, and the workflow is the stronger of the pair.
       */
      for (const workflow of identity.workflows.slice(0, 4)) {
        drafts.push({
          names: workflow.steps.flatMap((step) => step.actor.split(', ')),
          ...draft(
            'repository',
            'workflow',
            renderWorkflow(workflow),
            '@traceiq/framework',
            // The route-to-handler steps are recorded edges; the continuation past the handler is
            // conventional. The weaker of the two governs the whole line.
            workflow.steps.every((step) => step.confidence === 'CERTAIN') ? 'CERTAIN' : 'INFERRED',
          ),
        });
      }

      /*
       * The ranking, with the numbers that produced it.
       *
       * Not a claim about quality — it says how much of the repository points at a declaration, which
       * is what the graph measured. A reader who disagrees with the ranking can see exactly why it
       * ranked that way, which is the difference between a score and an assertion.
       */
      for (const component of identity.critical.slice(0, 5)) {
        drafts.push({
          names: [component.name],
          identities: component.kind === 'declaration' ? [component.id] : [],
          ...draft(
            component.kind === 'declaration' ? component.id : 'repository',
            'ranks',
            `${'★'.repeat(component.stars)}${'☆'.repeat(5 - component.stars)} ${component.name} — ${component.signals
              .map((signal) => signal.detail)
              .join('; ')}`,
            '@traceiq/health',
          ),
        });
      }

      return drafts;
    },
  },

  /**
   * The repository's top-level map: what each area is, and how big it is.
   *
   * **Pinned into the core beside the profile, because it answers the question the profile cannot.** On a
   * repository whose analysable code is four CI scripts, `profile` says `unknown`, `purpose` says nothing,
   * and every ranked declaration is a CI script — so a repository-wide question was answered from CI. The
   * area map says the repository declares git submodules, holds 85 files of CI and 4 of Azure deployment,
   * and carries no code of its own. That is six short lines and it is the whole answer.
   *
   * Question-independent by construction — a directory map does not change with the question — so it sits
   * in the stable prefix and costs nothing to reuse across a session.
   */
  {
    part: 'areas',
    caps: { minimal: 4, standard: 8, full: 12 },
    coreCaps: { minimal: 3, standard: 6, full: 10 },
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const structure = deriveStructure(context);
      const drafts: Draft[] = [];

      if (structure.category !== 'unknown') {
        drafts.push({
          ...draft(
            'repository',
            'characterised-as',
            `${structure.category} — ${structure.categoryEvidence.join('; ')}`,
            '@traceiq/ai',
            // Derived from the directory map by rule, exactly as the profile's claims are.
            'INFERRED',
          ),
        });
      }

      for (const area of structure.areas) {
        if (area.name === '' && area.declarations === 0) {
          // Loose files at the repository root are not an area anyone navigates to.
          continue;
        }

        drafts.push({
          names: [area.name],
          ...draft(
            'repository',
            'area',
            `${area.name === '' ? 'the repository root' : area.name} is ${area.role} — ${area.files} ${
              area.files === 1 ? 'file' : 'files'
            }, ${area.declarations === 0 ? 'no analysed declarations' : `${area.declarations} declarations`}`,
            '@traceiq/graph-api',
          ),
        });
      }

      return drafts;
    },
  },

  /**
   * What the repository is made of, when most of it is not source.
   *
   * **Pinned beside the area map, and for the same reason.** A repository of forty workflows and one
   * Python script has one analysable declaration and a language distribution that says Python — so every
   * part of the projection that reads declarations described a Python project, and the forty files that
   * actually constitute the repository were invisible. This is one line saying what the artefact families
   * are, with the counts that make it checkable.
   *
   * Question-independent, so it sits in the stable prefix. Four lines at `standard`: the families are a
   * short list on every repository, and the artefacts themselves are `key-artifacts` below.
   */
  {
    part: 'artifact-inventory',
    caps: { minimal: 3, standard: 6, full: 10 },
    coreCaps: { minimal: 2, standard: 4, full: 8 },
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      // Defensive, like every other read of the overview here: a caller may supply a context assembled
      // by something other than the Context Builder, and a missing part means "not established" rather
      // than a crash.
      const families = context.primary.value.overview.artifacts ?? [];

      if (families.length === 0) {
        return [];
      }

      return families.map((family) => ({
        names: [family.kind],
        ...draft(
          'repository',
          'artifact-inventory',
          `${family.files} ${family.kind} ${family.files === 1 ? 'file' : 'files'}${
            family.elements === 0
              ? ' — no structure was extracted from them'
              : `, from which ${family.elements} structural ${family.elements === 1 ? 'element was' : 'elements were'} read`
          }${family.examples.length === 0 ? '' : `, e.g. ${family.examples.join(', ')}`}`,
          '@traceiq/artifact',
        ),
      }));
    },
  },

  /**
   * The artefacts that describe the running system, each with what it declares.
   *
   * **The part that makes an architecture question answerable on a repository whose architecture is
   * written in YAML.** A compose file declaring `api`, `worker`, `postgres` and `redis`, with `api`
   * declaring that it needs `postgres`, *is* the architecture of that system — and no declaration count,
   * hotspot ranking or role annotation can see any of it. Nor is it a substitute for code analysis where
   * code exists: it sits below the architecture summary and above the ranked lists, which is where a fact
   * about the system's shape belongs.
   *
   * `artifact-ordering` is emitted only where an artefact **states** a prerequisite. That is the whole
   * discipline of this part: the entailment guard rejects an execution-order claim unless a relationship
   * licenses it, so an answer may narrate `build → deploy` exactly when the repository wrote `needs:
   * build` and never because one job appears above another.
   */
  {
    part: 'key-artifacts',
    caps: { minimal: 4, standard: 18, full: 44 },
    coreCaps: { minimal: 3, standard: 9, full: 22 },
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const drafts: Draft[] = [];

      for (const digest of context.primary.value.overview.keyArtifacts?.entries ?? []) {
        const declared = digest.declares.map((entry) => `${entry.count} ${entry.kind}`).join(', ');

        drafts.push({
          names: [digest.path, digest.kind],
          identities: [`file:${digest.path}`],
          ...draft(
            `file:${digest.path}`,
            'declares',
            `a ${digest.kind}${declared === '' ? ' from which no structure was extracted' : ` declaring ${declared}`}${
              digest.names.length === 0 ? '' : `: ${digest.names.join('; ')}`
            }`,
            '@traceiq/artifact',
          ),
        });

        for (const ordering of digest.ordering) {
          drafts.push({
            ...draft(
              `file:${digest.path}`,
              'artifact-ordering',
              // The wording is load-bearing: the artefact states the prerequisite, and whether a runner
              // honours it is not something any analysis here observed.
              `${ordering} — the artefact declares this prerequisite; the order it runs in was not observed`,
              '@traceiq/artifact',
            ),
          });
        }

        for (const reach of digest.reaches) {
          drafts.push({
            names: [reach.path],
            identities: [`file:${reach.path}`],
            ...draft(
              `file:${digest.path}`,
              reach.type === 'RUNS' ? 'runs' : reach.type === 'DOCUMENTS' ? 'documents' : 'references',
              `file:${reach.path}`,
              '@traceiq/artifact',
              // A command naming a path that resolves to a file is strong evidence of an invocation and
              // not proof of one: the reading did not follow control flow. See `invokedPaths`.
              reach.type === 'RUNS' ? 'INFERRED' : 'CERTAIN',
            ),
          });
        }

        if (digest.variables.length > 0) {
          drafts.push({
            names: digest.variables,
            identities: digest.variables.map((name) => `env:${name}`),
            ...draft(
              `file:${digest.path}`,
              'configures',
              `it supplies or names ${digest.variables.join(', ')} — variable names only; no value was read`,
              '@traceiq/artifact',
            ),
          });
        }
      }

      return drafts;
    },
  },

  /**
   * What a reader can actually start from, and the kind of evidence behind each.
   *
   * **Its own part because an onboarding answer built from a ranking is wrong however well it cites.** The
   * most-referenced declaration in a repository is the worst possible first file: it is referenced by
   * everything precisely because it assumes everything. Asked "what should I read first" about an umbrella
   * repository, the pipeline previously answered `set_secret.py`, correctly cited, because that is what
   * fan-in ranked — and that failure is a *retrieval* failure, not a prompt one. There was no fact of the
   * kind an onboarding answer needed, so the model was given facts of the kind it did not need.
   *
   * Four kinds of evidence, in descending directness, and **each one names its own kind** so an answer can
   * say why it recommends something:
   *
   * 1. **Documentation the repository ships**, and the files it links to. A README is the repository
   *    telling a reader where to start, in its own words.
   * 2. **An entry point a manifest declares** — a `main`, a `bin`, an `exports`.
   * 3. **Package boundaries**, which are where a repository states its own units.
   * 4. **Where control enters**, as the identity derived it: routes, or units nothing imports.
   *
   * Emitting nothing is a real outcome and is left to the planner to report. A repository with no
   * documentation, no manifest entry point and no route has not told anybody where to start, and inventing
   * a starting point from a fan-in count is the failure this part exists to prevent.
   */
  {
    part: 'onboarding',
    caps: { minimal: 4, standard: 12, full: 24 },
    coreCaps: { minimal: 2, standard: 5, full: 12 },
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const drafts: Draft[] = [];
      const overview = context.primary.value.overview;

      for (const digest of overview.keyArtifacts?.entries ?? []) {
        if (digest.kind === 'documentation') {
          const headings = digest.names
            .filter((name) => name.startsWith('heading '))
            .map((name) => name.slice('heading '.length));

          drafts.push({
            names: [digest.path],
            identities: [`file:${digest.path}`],
            ...draft(
              `file:${digest.path}`,
              'onboarding',
              `documentation the repository ships${headings.length === 0 ? '' : `, covering ${headings.slice(0, 6).join('; ')}`}`,
              '@traceiq/artifact',
            ),
          });

          for (const reach of digest.reaches) {
            if (reach.type !== 'DOCUMENTS') {
              continue;
            }

            drafts.push({
              names: [reach.path],
              identities: [`file:${reach.path}`],
              ...draft(
                `file:${reach.path}`,
                'onboarding',
                `documented by file:${digest.path}, which links to it`,
                '@traceiq/artifact',
              ),
            });
          }

          continue;
        }

        if (digest.kind !== 'package-manifest') {
          continue;
        }

        for (const name of digest.names) {
          drafts.push({
            names: [digest.path],
            identities: [`file:${digest.path}`],
            ...draft(
              `file:${digest.path}`,
              'onboarding',
              `${name}, declared by the manifest at file:${digest.path}`,
              '@traceiq/artifact',
            ),
          });
        }
      }

      const identity = deriveIdentity(context);

      if (identity.entryPoints !== null) {
        for (const entry of identity.entryPoints.value.slice(0, 4)) {
          drafts.push({
            names: [entry],
            ...draft(
              'repository',
              'onboarding',
              `${entry} — ${identity.entryPoints.evidence[0] ?? 'where control enters the repository'}`,
              '@traceiq/ai',
              // Derived from routes or from the absence of dependents, both of which are evidence about
              // structure rather than a statement the repository made about itself.
              'INFERRED',
            ),
          });
        }
      }

      return drafts;
    },
  },

  /**
   * What the system is, before anything is counted.
   *
   * **First, and that ordering is the milestone.** Everything after this is evidence; this is the
   * claim the evidence supports. A model handed a role count and a file count at the same rank
   * answers with both at the same rank — "there are 6 controllers", "src/modules contains 26 files" —
   * and never says what the repository does. Every field is a restatement of something the graph
   * asserted, and a field that cannot be proven is simply absent: LinkForge declares
   * `@prisma/adapter-pg` and no `pg`, so nothing here mentions PostgreSQL.
   */
  {
    part: 'architecture-summary',
    caps: ALL,
    extract: (context) => {
      /*
       * The repository kind only.
       *
       * A question about one declaration is not answered by the stack it happens to sit in, and
       * putting the technology layers ahead of the symbol's own identity was exactly the failure this
       * extractor was written to fix, pointed the other way: the first thing the model reads should be
       * the thing it was asked about.
       */
      if (context.primary.type !== 'repository') {
        return [];
      }

      const summary = summariseArchitecture(context);
      const drafts: Draft[] = [];

      /** One line per technology layer, carrying the detection's own evidence. */
      const layer = (label: string, entries: readonly TechnologyRef[]): void => {
        if (entries.length === 0) {
          return;
        }

        drafts.push({
          names: entries.map((entry) => entry.name),
          ...draft(
            'repository',
            'runs-on',
            // The responsibility, then the names, then the evidence. A reader who stops after the
            // first clause still knows what this layer is for; one who reads on can check it.
            `${label} — ${responsibilityOf(label)}: ${entries
              .map((entry) => `${entry.name}${entry.region === '' ? '' : ` (in ${entry.region})`}`)
              .join(', ')}. ${shorten(entries[0]?.evidence ?? '', 60)}`,
            '@traceiq/technology',
          ),
        });
      };

      layer('frontend', summary.frontend);
      layer('backend', summary.backend);
      layer('persistence', summary.persistence);
      layer('cache', summary.cache);
      layer('infrastructure', summary.infrastructure);
      layer('testing', summary.testing);
      layer('build', summary.build);

      for (const entry of summary.layers) {
        drafts.push({
          names: entry.members,
          ...draft(
            'repository',
            'layered',
            // Named, not counted. "14 repositories" tells a reader nothing they can act on;
            // `PrismaUrlRepository, PrismaAnalyticsRepository, UserRepository` tells them what is
            // persisted, that it is split by domain, and which file to open first.
            `${entry.role}: ${entry.members.join(', ')}${entry.declarations > entry.members.length ? ` and ${entry.declarations - entry.members.length} more` : ''} (${entry.declarations} in total)`,
            '@traceiq/framework',
            // A role is a judgement the Framework Extractor made from names and decorators, and the
            // health layer says so in its own `roles-are-judgements` limitation. Carried at that
            // strength rather than promoted to certainty by being summarised.
            'INFERRED',
          ),
        });
      }

      /*
       * What the layers agree the system is organised around.
       *
       * A noun reaches this list only when two or more different role layers contain it — a
       * `urlController`, a `urlService` and a `PrismaUrlRepository` are three independent annotations
       * converging on one domain. That convergence is a graph fact; what the domain *means* is left
       * to the reader, which is why the fact names the declarations rather than the product feature.
       */
      for (const capability of summary.capabilities) {
        drafts.push({
          names: [capability.noun, ...capability.members],
          ...draft(
            'repository',
            'capability',
            `'${capability.noun}' spans ${capability.layers.join(' + ')}: ${capability.members.join(', ')}`,
            '@traceiq/framework',
            'INFERRED',
          ),
        });
      }

      if (summary.configuration.length > 0) {
        drafts.push({
          names: summary.configuration,
          // The prefixed form of each name, for the reason the `environmentVariables` extractor
          // declares it: the model is told `env:` is an identifier prefix, so it writes one.
          identities: summary.configuration.map((name) => `env:${name}`),
          ...draft(
            'repository',
            'reads-env',
            `configuration: ${summary.configuration.join(', ')}`,
            '@traceiq/framework',
          ),
        });
      }

      for (const group of summary.routeGroups) {
        drafts.push({
          names: [group.prefix, group.example.split(' ')[1] ?? ''],
          ...draft(
            'repository',
            'exposes',
            `${group.count} ${group.methods.join('/')} ${group.count === 1 ? 'route' : 'routes'} under ${group.prefix}, for example ${group.example}`,
            '@traceiq/query',
          ),
        });
      }

      return drafts;
    },
  },

  /**
   * The layers a request passes through, as one fact.
   *
   * **The membership is measured; the order is a convention, and the fact says which is which.**
   * TraceIQ records that one declaration is annotated Controller and another Repository — it does not
   * record that the first calls the second on every request. Printing an arrow diagram without that
   * caveat would be the projection asserting a call graph it never built, which is exactly the kind of
   * plausible fabrication the whole layer exists to prevent.
   */
  {
    part: 'request-flow',
    caps: ALL,
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const summary = summariseArchitecture(context);

      if (summary.requestFlow.length < 2) {
        // One layer is not a flow. Emitting `HTTP request → Controller` would dress a single fact up
        // as a pipeline.
        return [];
      }

      /*
       * This repository's flow, not Express's.
       *
       * `HTTP → Middleware → Controller → Service → Repository → Prisma` is a diagram of the MVC
       * pattern; it would read identically for any Express application and tells a reader nothing
       * about the one in front of them. Naming the entry point, the actual middleware, the actual
       * controllers and where the data ends up makes the same sentence specific — and every name in it
       * is a declaration the graph recorded or a technology the detection proved.
       *
       * Each stage is included only when it exists. There is no fabricated authentication step, no
       * queue, no worker: if the annotations do not contain one, the arrow is not drawn.
       */
      const named = (role: string): string => {
        const layer = summary.layers.find((entry) => entry.role === role);

        if (layer === undefined) {
          return role;
        }

        const shown = layer.members.slice(0, 3).join(', ');

        return `${role} (${shown}${layer.declarations > 3 ? `, +${layer.declarations - 3}` : ''})`;
      };

      const stages: string[] = [];
      const claimable: string[] = [];

      if (summary.frontend.length > 0) {
        stages.push(`browser: ${summary.frontend.map((entry) => entry.name).join('/')}`);
        claimable.push(...summary.frontend.map((entry) => entry.name));
      }

      if (summary.backend.length > 0) {
        stages.push(`${summary.backend.map((entry) => entry.name).join('/')} HTTP layer`);
        claimable.push(...summary.backend.map((entry) => entry.name));
      } else {
        stages.push('HTTP request');
      }

      for (const role of summary.requestFlow) {
        stages.push(named(role));
        claimable.push(...(summary.layers.find((entry) => entry.role === role)?.members ?? []));
      }

      if (summary.cache.length > 0) {
        stages.push(`${summary.cache.map((entry) => entry.name).join('/')} (cache)`);
        claimable.push(...summary.cache.map((entry) => entry.name));
      }

      if (summary.persistence.length > 0) {
        stages.push(summary.persistence.map((entry) => entry.name).join('/'));
        claimable.push(...summary.persistence.map((entry) => entry.name));
      }

      return [
        {
          names: claimable,
          ...draft(
            'repository',
            'request-flow',
            `${stages.join(' → ')} (every stage named here exists; the order is the conventional one, not a measured call chain)`,
            '@traceiq/framework',
            'INFERRED',
          ),
        },
      ];
    },
  },

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
            `${entry.name} (${entry.category})${describeRegions(entry.regions)} — ${shorten(entry.evidence, 70)}`,
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
        readonly role: string;
        readonly paths: string[];
        files: number;
        sources: number;
        reason: string;
      }

      const groups = new Map<string, Group>();

      for (const region of context.capabilities.regions) {
        const language = region.primaryLanguage ?? 'no dominant source language';
        /*
         * Grouped by role as well as by language and depth.
         *
         * **Caught in a live answer rather than in review.** Asked to explain `stripe/ai`'s architecture,
         * the model wrote "953 files across five main regions: benchmarks/furever, tools/python,
         * llm/ai-sdk, benchmarks/card-element-to-checkout, benchmarks/saas-starter-partial-payments" —
         * naming three benchmark fixtures among the repository's main regions. Every other consumer of
         * structural scope had been fixed and this fact still presented all fifty regions as equals,
         * largest first, which on a repository that is 72% demonstrations means the demonstrations lead.
         */
        const role = roleOfPath(region.path);
        const identity = `${language} :: ${region.depth} :: ${role}`;
        const held = groups.get(identity);
        const where = region.path === '' ? 'the repository root' : region.path;

        if (held === undefined) {
          groups.set(identity, {
            language,
            depth: region.depth,
            role,
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

      /*
       * Production regions first, then largest.
       *
       * The shape of a repository is what most of *its own code* is made of — not what most of the tree
       * is made of, which on a repository built to hold sample applications is the sample applications.
       */
      return [...groups.values()]
        .sort(
          (left, right) =>
            Number(right.role === 'production') - Number(left.role === 'production') ||
            right.sources - left.sources ||
            left.language.localeCompare(right.language),
        )
        .map((group) => {
          const named = [...group.paths].sort().slice(0, 3);
          const rest = group.paths.length - named.length;

          return {
            names: [...group.paths, group.language],
            ...draft(
              'analysis',
              'region-depth',
              `${group.paths.length} ${group.language} ${group.paths.length === 1 ? 'region' : 'regions'} of ${group.role} code (${group.sources} of ${group.files} files are source) analysed to ${group.depth} depth — ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
              '@traceiq/graph-api',
            ),
          };
        });
    },
  },

  /**
   * What the analysis could not determine, as codes rather than paragraphs.
   *
   * **The largest single cost in the prompt, and the least useful per token.** Measured on
   * `facebook/react`: 17 limitation facts costing **1,081 tokens — 20% of the entire prompt, on every
   * question**, more than packages, dependencies or hotspots. Each was a full fixed sentence, and the
   * sentences are written for a reader looking at one capability's output, not for a model composing
   * an answer about a repository.
   *
   * They also actively damaged answers. Asked what to understand first about React, the model ended
   * with *"The repository overview is computed independently for health reports [f38]"* — a caveat
   * about TraceIQ's own internals, restated as though it were a fact about React. Verbose boilerplate
   * in a prompt does not sit inertly; a model reaching for something to say will say it.
   *
   * So the codes are kept — they are the actionable half, and dropping them would break the promise
   * that an absence is never presented as a measurement — and the prose is not. One fact, cited once,
   * naming everything that qualifies the answer.
   */
  {
    part: 'limitations',
    caps: ALL,
    extract: (context) => {
      if (context.limitations.length === 0) {
        return [];
      }

      // Deduplicated and counted: several capabilities raise `capped-lists`, and three copies of one
      // code says nothing three times.
      const byCode = new Map<string, number>();

      for (const limitation of context.limitations) {
        byCode.set(limitation.code, (byCode.get(limitation.code) ?? 0) + 1);
      }

      const codes = [...byCode.keys()].sort();

      return [
        draft(
          'analysis',
          'limitation',
          `these qualify every answer: ${codes.join(', ')}`,
          '@traceiq/context',
          'CERTAIN',
        ),
      ];
    },
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

  /**
   * The repository's tests, by name, with what each appears to exercise.
   *
   * **This part exists because a whole class of question had no evidence to be answered from.** The only
   * test fact a prompt ever carried was `N declarations carry the Test role` — a count. Asked "what tests
   * should I read first?", the projection had nothing to offer, the importance ranking answered instead,
   * and the reader received an architecture overview. A count cannot be opened.
   *
   * Two confidences, kept apart the way a workflow's steps are. The file and the package it sits in are
   * recorded paths, so the line is `CERTAIN`. What the test *covers* is a match between its filename and a
   * declaration the repository annotated — a naming convention across two independently recorded facts,
   * never an observed relationship — so a line carrying one is `INFERRED` and says so in its own words.
   */
  {
    part: 'tests',
    caps: { minimal: 3, standard: 8, full: 16 },
    coreCaps: { minimal: 0, standard: 0, full: 0 },
    extract: (context) => {
      if (context.primary.type !== 'repository') {
        return [];
      }

      const { testFiles } = summariseArchitecture(context);

      return testFiles.map((test) => {
        const where = test.area === '' ? '' : `, in ${test.area}`;
        const covers =
          test.covers.length === 0
            ? ' — the analysis cannot say what it exercises'
            : ` — its name matches ${test.covers.join(', ')}, which is a naming convention rather than an observed relationship`;

        return {
          names: [test.name, test.path, ...test.covers],
          identities: [`file:${test.path}`],
          ...draft(
            'repository',
            'tested-by',
            `${test.path}${where}${covers}`,
            '@traceiq/framework',
            test.covers.length === 0 ? 'CERTAIN' : 'INFERRED',
          ),
        };
      });
    },
  },

  {
    part: 'environmentVariables',
    caps: FEW,
    extract: (context) => {
      const subject = subjectOf(context) ?? 'repository';

      return context.dependencies.environmentVariables.map((node) => ({
        /*
         * The `env:` identifier the fact stands for, declared rather than printed.
         *
         * The fact reads `reads-env REDIS_URL`, because the bare name is what prose uses and printing
         * the prefixed form twice would cost tokens to say the same thing. But the standing instruction
         * tells the model that identifiers begin `sym:`, `file:`, `route:`, `env:` or `ext:` — so a
         * model that writes `env:REDIS_URL` is using the vocabulary it was given, and the guard was
         * calling that an invention. `identities` exists for exactly this: an identifier an admitted
         * fact stands for without rendering it.
         */
        identities: [node.id],
        ...draft(subject, 'reads-env', node.name, '@traceiq/framework'),
      }));
    },
  },

  {
    part: 'routes',
    caps: FEW,
    extract: (context) =>
      context.routes.map((route) => ({
        // A route is referred to by its path — `/todos/:id` — far more often than by method and path
        // together, and never by the identifier of the declaration that handles it. Both forms are
        // claimable; a model that names the route it just read about is not inventing anything.
        names: [route.composition.effectivePath, `${route.method} ${route.composition.effectivePath}`],
        ...draft(
          route.node.id,
          'handles-route',
          `${route.method} ${route.composition.effectivePath}`,
          '@traceiq/framework',
        ),
      })),
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
 * A fixed explanatory sentence, cut to the part that identifies it.
 *
 * **Evidence has to stay checkable, not stay complete.** A technology's evidence reads "Yarn is used:
 * yarn.lock the lockfile this package manager writes" — the first clause names the file a reader can
 * go and look at, and the rest explains what a lockfile is to somebody who already knows. Measured on
 * React, `built-with` cost 777 tokens across ten facts; the tails are most of that.
 *
 * Cut on a word boundary and marked with an ellipsis, so a truncated string never reads as a complete
 * one.
 */
function shorten(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');

  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
  /**
   * The **question-independent** part of that reservation — the standing instruction, the repository
   * guidance, the scaffolding. Everything that is identical for two questions about one repository.
   *
   * **This exists because the stable core stopped being stable, and nothing else could have caught
   * it.** The core's ceiling is a share of `TIER − reserved`, and `reserved` includes the question and
   * the guidance the question steers. That was harmless while question guidance was forty tokens: the
   * ceiling moved a little, the same facts still fitted under it, and `coreCount` came out the same.
   * Once the planner began emitting workflows and a ranked component list, question guidance ranged
   * from 205 to 457 tokens across one battery — the ceiling moved by hundreds, a different number of
   * facts fitted, and the rendered prefix differed between two questions about the same repository.
   * Measured: the prefix was identical on 3 of 13 repositories and different on the other 10.
   *
   * Deriving the core's ceiling from the fixed part alone restores the property the whole
   * prefix-reuse design rests on. Omitted, this falls back to `reserved` and behaves exactly as
   * before — which is right for a caller that has no question in hand.
   */
  readonly coreReserved?: number;
  readonly counter?: TokenCounter;
  /**
   * What the question is about. Decides the **supplement** only; the core is identical either way.
   *
   * Omitted means `overview`, the balanced projection — which is also what a caller inspecting a
   * projection without a question in hand should see.
   */
  readonly intent?: QuestionIntent;
  /**
   * Fact parts the answer plan asked for, ahead of what the intent asks for.
   *
   * **The plan outranks the intent, because the plan knows what the answer is made of.** "Where should
   * I start?" classifies as `architecture` and would receive role counts; the plan reads it as an
   * orientation question and asks for packages and entry points instead. Passing this is optional —
   * omitted, the projection behaves exactly as it did before the planner existed.
   */
  readonly parts?: readonly string[];
  /**
   * What share of the supplement each group of facts may take.
   *
   * **Reordering was not enough.** `parts` puts the plan's parts at the front of the supplement, and
   * the front of the supplement is where nearly all of its budget goes: the first extractors to run
   * take what they want and the rest take what is left. So a workflow question got its `request-flow`
   * facts *and* whatever large listing sorted next, and the ranked components the plan had also asked
   * for were priced out by a part nothing had asked for at all. Ordering decides what runs first; only
   * a share decides what it may spend.
   *
   * **The supplement only, and never the core.** An allocation is derived from the question, and the
   * core exists to be identical between two questions about one repository — the property the whole
   * prompt-prefix reuse rests on, and one already broken once by exactly this kind of question-derived
   * quantity reaching the core's ceiling. See `coreReserved`.
   *
   * **Nothing is wasted.** A group that does not spend its share leaves the room to a second,
   * unallocated sweep over the same extractors, which admits whatever the shares refused while the
   * budget lasts. Measured across thirteen repositories and ten questions each, the allocated
   * projection spends the same budget to within one fact of the unallocated one, every time.
   *
   * **What changes is the composition, and the count moves with it.** An allocation buys different
   * facts, not more of them: React asked how authentication works went from 32 supplement facts to 47
   * — fourteen more hotspot rankings and three more configuration reads, for three fewer role counts —
   * while Express asked to explain its architecture went from 77 to 71, trading six cheap package
   * lines for the role facts a layered answer is actually made of. A count that moved either way is
   * the shares working; a token total that fell would be the bug, and is what the sweep prevents.
   */
  readonly allocation?: FactAllocation;
}

/**
 * Which of the four groups each part belongs to.
 *
 * **The mapping lives here rather than beside the shares, because the part names are this file's.** A
 * share table in the planner that named `environmentVariables` would be the planner asserting something
 * about an extractor it cannot see; naming the groups there and the membership here means a new
 * extractor is classified by the file that declares it.
 *
 * Unlisted parts are `supporting`, which is the honest default: the other three name what an answer is
 * *built from*, and a part that is none of them is evidence behind one of them.
 */
const GROUP_OF: Readonly<Record<string, FactGroup>> = {
  profile: 'architecture',
  purpose: 'architecture',
  'architecture-summary': 'architecture',
  architecture: 'architecture',
  regions: 'architecture',
  composition: 'architecture',
  cycles: 'architecture',
  // The artefact inventory and the system artefacts are architecture: on a repository whose services are
  // wired in YAML they are the *only* architecture, and grouping them as `supporting` would let the
  // allocation starve them on exactly the questions they answer.
  'artifact-inventory': 'architecture',
  'key-artifacts': 'architecture',
  'request-flow': 'workflow',
  routes: 'workflow',
  // Where to start is a claim about the repository's shape rather than about a component, and the
  // orientation lead allocates most of its budget to `architecture`.
  onboarding: 'architecture',
  packages: 'components',
  hotspots: 'components',
  'impact-summary': 'components',
  incomingCalls: 'components',
  outgoingCalls: 'components',
  related: 'components',
  identity: 'components',
};

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

  // Derived once, here, and carried on the result. The extractors, the ordering and every consumer
  // downstream read this same object, so what a prompt says about the repository and what the facts say
  // about it cannot drift apart.
  const profile = deriveProfile(context);

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
   * Stops once the pass's own ceiling is reached, so the caller does not keep calling extractors whose
   * output cannot be afforded.
   *
   * With an `allocation`, each group additionally gets a share of whatever the pass began with, and an
   * extractor whose group is exhausted is **skipped rather than terminal** — the other groups still have
   * room, and ending the pass there would hand the whole remainder to nobody. Only the pass ceiling
   * ends a pass.
   */
  const run = (
    extractors: readonly Extractor[],
    ceiling: number,
    core: boolean,
    allocation?: FactAllocation,
  ): void => {
    /** Spend per group, and the room each may have. Both empty where no allocation was given. */
    const groupSpent = new Map<FactGroup, number>();
    const share = Math.max(0, ceiling - spent);

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
      const group = GROUP_OF[extractor.part] ?? 'supporting';
      const room = allocation === undefined ? Number.POSITIVE_INFINITY : Math.floor(share * allocation[group]);

      let used = groupSpent.get(group) ?? 0;
      let kept = 0;
      /** Whether the pass itself ran out, as opposed to this one group's share. */
      let exhausted = false;

      for (const candidate of capped) {
        sequence += 1;
        const fact: Fact = { ...candidate, id: `f${sequence}` };
        const line = factLine(fact);
        const cost = counter.count(line);

        if (spent + cost > ceiling) {
          // This pass is exhausted. Undo the candidate's id so numbering stays contiguous, and stop —
          // admitting later, cheaper facts out of order would break the fixed priority.
          sequence -= 1;
          exhausted = true;
          break;
        }

        if (used + cost > room) {
          // This group's share is spent. The pass continues: the facts refused here are offered again
          // by the unallocated sweep, and only after every other group has had its share.
          sequence -= 1;
          break;
        }

        seen.add(key(candidate));
        facts.push(fact);
        claimed.push(...(candidate.names ?? []));
        represented.push(...(candidate.identities ?? []));
        lines.push(line);
        spent += cost;
        used += cost;
        kept += 1;
      }

      groupSpent.set(group, used);

      const held = tally.get(extractor.part) ?? { kept: 0, total: 0 };

      // `total` is the largest this part was ever seen to offer. Every pass sees the same context, but
      // a later one sees fewer candidates because the earlier ones consumed some — summing would
      // double-count.
      tally.set(extractor.part, { kept: held.kept + kept, total: Math.max(held.total, held.kept + drafts.length) });

      if (exhausted) {
        // Nothing later in this pass can fit either, since every extractor after it is lower priority.
        return;
      }
    }
  };

  // Pass one: the stable core. Extractor order, core caps, and a fixed share of the budget — nothing
  // here reads the question, which is precisely what lets the rendered prefix be reused between them.
  // The *profile* may reorder it, and that is safe for the same reason: a profile depends on the
  // repository and not on the question, so the prefix is still byte-identical between two questions.
  //
  // The ceiling comes from the **question-independent** reservation, so two questions about one
  // repository admit the same core facts and render the same prefix. See `coreReserved`.
  const coreBudget = TIER_TOKENS[options.tier] - (options.coreReserved ?? options.reserved ?? 0);

  // Never larger than what is actually left: a core that overran the real budget would leave the
  // supplement negative and silently drop every question-specific fact.
  run(shapedFor(profile), Math.max(0, Math.min(Math.floor(coreBudget * CORE_SHARE), budget)), true);

  /**
   * The boundary, recorded here rather than re-derived afterwards.
   *
   * A first version counted forward through the rendered lines until the core's token ceiling was
   * reached, which is wrong whenever the whole projection costs less than that ceiling: every
   * supplement fact then fell inside the "stable" prefix, and the prefix stopped being stable the
   * moment the question changed. The boundary is a fact of the pass, so the pass is what states it.
   */
  const coreCount = facts.length;

  // Pass two: the supplement, led by whatever the question is about — within the order the repository's
  // own shape already set, so a technology question about a huge repository still gets its packages
  // before its hotspots — and divided between the four groups where the plan said how.
  const supplement = orderedFor(intent, profile, options.parts ?? []);

  run(supplement, budget, false, options.allocation);

  /*
   * Pass three: whatever the shares refused, while the budget lasts.
   *
   * **An allocation is a statement of preference, not a cap on the answer.** Without this, a plan that
   * reserved 40% for workflow facts on a repository with two of them would leave a third of the budget
   * unspent — and the facts it declined to buy are the same facts an unplanned projection would have
   * had. Running the identical extractor order a second time costs one more pass over data already in
   * memory and admits only what `seen` proves was never emitted.
   *
   * Skipped where the allocated pass already spent what it was given, which is the common case on any
   * repository large enough for the budget to bind.
   */
  if (options.allocation !== undefined && spent < budget) {
    run(supplement, budget, false);
  }

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
    profile,
    // Derived once per context and cached there, so this is a lookup rather than a second ranking.
    identity: context.primary.type === 'repository' ? deriveIdentity(context) : null,
    tokens: spent,
    digest: digest(lines),
  };
}

/**
 * What each kind of repository needs its facts to be *about*, before any question is asked.
 *
 * **This is Phase 7 at the repository axis, and it is the half the intent classifier could never
 * supply.** `INTENT_PARTS` answers "this question is about caching, so lead with technologies"; it has
 * no opinion about the fact that a framework's answer is made of packages and exports while a service's
 * is made of routes and layers. Given the same question, the two need different facts, and until this
 * existed both received the declared order — which is the application order, because that is what the
 * declared order was tuned on.
 *
 * A **reordering, never a filter**, exactly as `orderedFor` is: every extractor still runs, so a type
 * rule that fired wrongly costs a differently-ordered projection rather than a missing part of the
 * repository. That is what keeps a rule table safe enough to be a rule table.
 */
const TYPE_PARTS: Readonly<Record<string, readonly string[]>> = {
  // A request is the thing to explain, so the surfaces and the layers come first.
  application: ['routes', 'architecture', 'technologies', 'packages'],
  service: ['routes', 'architecture', 'environmentVariables', 'technologies'],
  // A consumer's question is answered by the units and what they export, never by a route.
  framework: ['packages', 'regions', 'externalPackages', 'hotspots'],
  library: ['packages', 'externalPackages', 'hotspots', 'technologies'],
  sdk: ['packages', 'externalPackages', 'architecture', 'technologies'],
  cli: ['packages', 'architecture', 'environmentVariables', 'externalPackages'],
  // Nothing was analysed but manifests and configuration; that is the whole of the answer.
  infrastructure: ['technologies', 'environmentVariables', 'regions', 'composition'],
  // The pipeline is the architecture, and the packages are its stages.
  compiler: ['packages', 'regions', 'hotspots', 'cycles'],
  monorepo: ['packages', 'regions', 'composition', 'technologies'],
  tooling: ['packages', 'architecture', 'externalPackages', 'technologies'],
  unknown: [],
};

/**
 * Parts nothing may reorder.
 *
 * **A guard rather than a preference, and it was added because reordering broke the thing the previous
 * milestone built.** `TYPE_PARTS` for an application named `request-flow` first, and a stable sort duly
 * lifted it above `profile` and `architecture-summary` — so the first fact a model read about a web
 * service was the request flow, and what the system *is* had been pushed below what it *does*. Every
 * part here is small, `ALL`-capped and needed by every answer regardless of type: the two that say what
 * the repository is, the subject's own identity, and the limitations that are the honesty guarantee.
 * Steering is for the ranked lists, which is where all the budget is anyway.
 */
const PINNED: readonly string[] = [
  'areas',
  /*
   * The artefact inventory joins the pinned set, and only the inventory.
   *
   * It is one short list saying what the repository is made of when most of it is not source — the same
   * job the area map does one level up, and needed by every answer for the same reason. `key-artifacts` is
   * deliberately *not* pinned: it is the ranked-list-shaped part of artefact evidence, so it belongs in the
   * steerable region where a deployment question can lift it and an API question can leave it.
   */
  'artifact-inventory',
  'profile',
  'purpose',
  'architecture-summary',
  'request-flow',
  'identity',
  'limitations',
];

/**
 * Extractors ordered for the repository this is, before the question is considered.
 *
 * Runs on the **core** pass as well as feeding the supplement, and that is deliberate: the core is the
 * part every answer rests on, so a framework whose core is full of route facts has already lost the
 * answer before the intent gets a say. It stays safe for prefix reuse because a profile is a function
 * of the repository alone — two questions about one repository produce the same order and therefore the
 * same bytes.
 */
function shapedFor(profile: RepositoryProfile): readonly Extractor[] {
  const wanted = TYPE_PARTS[profile.type.value] ?? [];

  /*
   * A huge repository is reordered whatever its type, because at that size the failure is the same for
   * all of them: the answer must be built from the units and the boundaries between them, and a ranked
   * list of individual declarations spends the budget on detail nobody asked for. `hotspots` is not
   * removed — nothing ever is — it simply stops out-ranking the package list.
   */
  const scaled = profile.scale.scale === 'huge' ? ['packages', 'regions', ...wanted] : wanted;

  return reordered(EXTRACTORS, scaled, true);
}

/**
 * Extractors with the ones this question is about brought to the front.
 *
 * A **reordering, never a filter**: every extractor still runs, so an intent the classifier got wrong
 * costs a differently-ordered supplement rather than a missing part of the repository. That property is
 * what lets the classifier be six lines of keyword matching instead of a second model call.
 *
 * The intent is applied **on top of** the repository's own order rather than instead of it, so the two
 * compose: the question decides what leads, and the repository decides everything the question did not
 * name. A framework asked about caching gets its cache technologies first and its packages second,
 * rather than the route facts an application would have received.
 */
function orderedFor(
  intent: QuestionIntent,
  profile: RepositoryProfile,
  planned: readonly string[],
): readonly Extractor[] {
  // The plan's parts lead, then the intent's, then the repository's own order behind both. A part the
  // plan and the intent both name keeps the plan's position, because `reordered` is a stable sort and
  // the plan is applied last.
  const wanted = [...planned, ...INTENT_PARTS[intent].filter((part) => !planned.includes(part))];
  const shaped = shapedFor(profile);

  /*
   * The intent sorts *without* pinning, and the asymmetry with `shapedFor` is deliberate.
   *
   * The core pass is where the essential parts are guaranteed, so that is where they are protected. The
   * supplement's entire purpose is to be led by the question — lifting the pinned parts here as well
   * would mean that on any repository whose core exhausted its budget, every question's supplement
   * opened with the same identity facts and the intent decided nothing. `INTENT_PARTS` names no pinned
   * part in any case, so this preserves exactly the behaviour the supplement already had.
   */
  return wanted.length === 0 ? shaped : reordered(shaped, wanted, false);
}

/**
 * A stable sort that brings the named parts to the front.
 *
 * With `pin`, three ranks rather than two: the pinned parts hold rank `-1` and keep their declared order
 * at the very front whatever was asked for, the named parts follow in the order they were named, and
 * everything else keeps its declared order behind both. Naming a pinned part then changes nothing, which
 * is the intended reading of `PINNED`.
 */
function reordered(
  extractors: readonly Extractor[],
  wanted: readonly string[],
  pin: boolean,
): readonly Extractor[] {
  if (wanted.length === 0) {
    return extractors;
  }

  const rank = (extractor: Extractor): number => {
    if (pin && PINNED.includes(extractor.part)) {
      return -1;
    }

    const index = wanted.indexOf(extractor.part);

    return index === -1 ? wanted.length : index;
  };

  // A stable sort, so parts the caller did not name keep their declared order behind the ones it did.
  return [...extractors].sort((left, right) => rank(left) - rank(right));
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

      /*
       * The identifier without its prefix.
       *
       * Caught in the product: asked which declarations are most referenced, the model answered
       * correctly and wrote `packages/react-reconciler/src/ReactInternalTypes.js#Fiber` — the same
       * identifier the facts carried, minus the four characters of `sym:`. The guard called it a name
       * no fact contained.
       */
      add(body);

      const [path, chain] = body.split('#');

      if (path !== undefined) {
        add(path);

        /*
         * The file's own name, which is how prose refers to it.
         *
         * Caught in the product rather than in review: asked to explain React's architecture, the
         * model wrote a correct, well-cited answer naming `ModalDialog.js`, `ProfilerContext.js` and
         * `InspectedElementContext.js`, and the guard marked all three as terms no fact carried — for
         * three files whose full paths were sitting in the identifiers it had just been given. Nobody
         * writing about a file calls it `packages/react-devtools-shared/src/…/ModalDialog.js` in a
         * sentence, and a verifier that demands they do is wrong about a right answer.
         */
        add(path.split('/').at(-1) ?? '');
      }

      if (chain !== undefined) {
        add(chain);
        add(chain.split('.').at(-1) ?? '');
      }
    }
  }

  return terms;
}
