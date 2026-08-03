import type { QuestionIntent, QuestionScope } from './intent.js';
import type { ComplexityTrait, DomainClaim, RepositoryProfile, RepositoryType, TraitClaim } from './profile.js';
import type { RepositoryIdentity } from './identity.js';
import type { AnswerPlan, Audience } from './plan.js';
import { renderWorkflowBrief } from './workflow.js';

/**
 * How this repository should be explained, and how far down.
 *
 * **The profile says what the repository is; this says what to do about it.** Keeping them apart is the
 * point: `profile.ts` may only restate what the graph holds, while everything here is a *decision* about
 * presentation, and mixing the two would make it impossible to review either. Nothing in this file
 * claims anything about the repository. It selects instructions.
 *
 * The instructions are selected along two axes that are genuinely independent:
 *
 * - **Depth**, from the repository's scale. A repository whose every package fits in one answer should
 *   get one answer; a repository whose package *list* does not fit must not be described as a whole, and
 *   an instruction to "explain the architecture" would otherwise produce a summary of a summary.
 * - **Focus**, from the question's scope. "Explain Redis" is a question about one subsystem however
 *   large the repository is, and the depth rules must not override it — the drill-down instruction for a
 *   huge repository and a question already aimed at one subsystem would otherwise fight each other.
 *
 * **Two renderings, and the split is a cache optimisation rather than an aesthetic one.** A provider
 * reuses the longest prompt prefix it has already evaluated, and the system message sits at the very
 * front of that prefix. So the half of the guidance that depends only on the repository is rendered into
 * the system message, where it is byte-identical for every question, and the half that depends on the
 * question is rendered after the question, where it costs nothing to vary. Putting question-derived text
 * in the system message would invalidate the whole prefix on every turn.
 */

export const EXPLANATION_DEPTHS = [
  /** Everything: every subsystem, the request flow end to end, nothing summarised away. */
  'complete',
  /** The major modules and how they interact, without walking every file. */
  'modules',
  /** Subsystem boundaries and responsibilities, with a drill-down offered. */
  'boundaries',
  /** One subsystem only, named, with the rest deliberately left alone. */
  'focused',
] as const;

export type ExplanationDepth = (typeof EXPLANATION_DEPTHS)[number];

export interface ExplanationStrategy {
  readonly depth: ExplanationDepth;
  /** What the answer should open with. One sentence, in the imperative. */
  readonly opening: string;
  /** What to explain, in the order it should be explained. */
  readonly cover: readonly string[];
  /** What this repository's shape makes a mistake. Empty when nothing is worth forbidding. */
  readonly avoid: readonly string[];
  /** The drill-down to offer, or `null` where the answer can be complete. */
  readonly closing: string | null;
  /** The subsystem the question named, where it named one the profile can confirm. */
  readonly focus: string | null;
}

/**
 * What each repository type makes worth explaining, in order.
 *
 * **This is the whole of Phase 5 in one table, and its being a table is deliberate.** The alternative —
 * conditionals threaded through a prompt builder — hides the fact that the product's opinion about how
 * to explain a framework differs from its opinion about a service, and makes the two impossible to
 * compare. Here they sit side by side and a reviewer can disagree with one line.
 *
 * Each entry names *responsibilities*, never counts, and every one of them is a thing the projection can
 * actually supply facts for. An entry naming something the graph does not carry would produce an answer
 * that had to say "the facts do not settle this", which is worse than not asking.
 */
const TYPE_FOCUS: Readonly<Record<RepositoryType, { readonly opening: string; readonly cover: readonly string[]; readonly avoid: readonly string[] }>> = {
  application: {
    opening: 'Open with what the application does for its users and what it is built on.',
    cover: [
      'where a request enters and what it passes through',
      'what each layer is responsible for',
      'where state is kept, and what makes repeated reads fast',
      'what the application exposes, by route group rather than by count',
    ],
    avoid: ['do not enumerate files or packages before the request flow is clear'],
  },
  service: {
    opening: 'Open with what the service is responsible for and who calls it.',
    cover: [
      'the routes it exposes, grouped by what they are for',
      'how a request moves from the route to persistence',
      'where state is kept and what is cached',
      'what configuration it requires to run',
    ],
    avoid: ['do not describe a user interface — none was detected'],
  },
  framework: {
    opening: 'Open with what the framework is for and what someone building on it writes against.',
    cover: [
      'the public surface: what a consumer imports',
      'the extension points — plugins, adapters, presets — and what each one hooks into',
      'the internal packages and what each is responsible for',
      'how the pieces fit together at runtime',
    ],
    avoid: [
      'do not enumerate every package; name the ones a consumer or a contributor would open first',
      'do not describe a request flow — a framework has no single one',
    ],
  },
  library: {
    opening: 'Open with what the library does and what a caller gets from it.',
    cover: [
      'the public API and what it is for',
      'how the implementation is organised behind that API',
      'what it depends on, and what that dependency buys',
    ],
    avoid: ['do not describe a request flow or a deployment model — a library has neither'],
  },
  sdk: {
    opening: 'Open with what the SDK talks to and what a caller uses it for.',
    cover: [
      'the client surface a caller constructs and calls',
      'how requests are built, sent and authenticated',
      'how the surface is organised by resource',
    ],
    avoid: ['do not describe a server — this is the client side'],
  },
  cli: {
    opening: 'Open with what the tool does when someone runs it.',
    cover: [
      'the commands it offers and what each one does',
      'how a command reaches the work it performs',
      'what it reads from configuration or the environment',
    ],
    avoid: ['do not describe routes or a request flow — this is invoked from a shell'],
  },
  infrastructure: {
    opening: 'Open with what this deploys and where.',
    cover: [
      'the deployment model: what is built, what is shipped, what runs it',
      'the environments and what differs between them',
      'the configuration a deployment must supply',
    ],
    avoid: ['do not describe application code — none was analysed here'],
  },
  compiler: {
    opening: 'Open with what this compiles, from what to what.',
    cover: [
      'the compilation pipeline, stage by stage, in the order input moves through it',
      'what each stage consumes and produces',
      'where the intermediate representations live',
    ],
    avoid: ['do not describe a request flow or a deployment model'],
  },
  monorepo: {
    opening: 'Open with what the repository holds and how it is divided.',
    cover: [
      'the major units and what each is for',
      'how the units depend on one another',
      'what is shared between them',
    ],
    avoid: ['do not describe the repository as one system if the units are independent'],
  },
  tooling: {
    opening: 'Open with what the tooling does for the code it is pointed at.',
    cover: [
      'what it takes as input and what it produces',
      'how the work is organised internally',
      'how it is invoked',
    ],
    avoid: ['do not describe a request flow or a user interface'],
  },
  unknown: {
    /*
     * The honest fallback. The type rules found no evidence they trust, so the instruction says nothing
     * about type and leans entirely on scale and on the domains, both of which are always measurable.
     * An invented type here would be a fabrication upstream of every sentence in the answer.
     */
    opening: 'Open with what the repository contains and what it appears to be organised around.',
    cover: [
      'the major units and what each is for',
      'the domains the code is organised around',
      'what it is built with',
    ],
    avoid: ['do not assert what kind of project this is — the evidence does not settle it'],
  },
};

/**
 * What each depth permits and requires.
 *
 * The four are genuinely different instructions rather than four dials on one. `complete` forbids
 * summarising; `focused` forbids breadth. A single "be more or less detailed" parameter would have
 * produced a shorter version of the same wrong answer for a huge repository.
 */
const DEPTH_RULES: Readonly<Record<ExplanationDepth, { readonly instruction: string; readonly closing: string | null }>> = {
  complete: {
    instruction:
      'This repository is small enough to explain completely. Walk every major subsystem and trace the flow end to end. Do not summarise what you could simply explain.',
    closing: null,
  },
  modules: {
    instruction:
      'Explain the major modules and how they interact. Do not describe every file — name the modules, say what each is responsible for, and show how they connect.',
    closing: null,
  },
  boundaries: {
    instruction:
      'This repository is too large to explain at once. Start from the major subsystems and the boundaries between them: what each is responsible for, and how they relate. Stay at that level.',
    closing: 'Close by naming the two or three subsystems most worth asking about next.',
  },
  focused: {
    instruction:
      'Explain only what the question asks about. Do not describe the repository as a whole; place the subject inside the architecture in a sentence and spend the rest of the answer on the subject itself.',
    closing: 'Close by naming what connects to it, so the reader knows where to look next.',
  },
};

/**
 * Depth, from the repository's scale and the question's scope.
 *
 * **Scope wins wherever it is narrower, and that precedence is the fix for a real conflict.** A huge
 * repository asked "explain Redis" would otherwise receive the boundaries instruction — start from the
 * major subsystems — and answer with an architecture overview that never mentions Redis. Scale decides
 * how much of a repository an answer may attempt; a question that has already named its own subject has
 * decided that for itself.
 */
function depthOf(profile: RepositoryProfile, scope: QuestionScope, lead?: string): ExplanationDepth {
  /*
   * A locating question is narrow whatever the repository's size, and that is question breadth rather
   * than question scope.
   *
   * **Depth read the repository and the scope and never the question's own breadth**, so "what tests
   * should I read first?" on a medium repository was given the `modules` instruction — explain the major
   * modules and how they interact — for a question whose whole answer is four filenames. Padding a simple
   * answer is the failure this closes, and it is the mirror image of truncating a complex one: the
   * `boundaries` and `complete` rules below still stand exactly as they were, so a broad question about a
   * large repository keeps every bit of its substance.
   */
  if (lead === 'locate') {
    return 'focused';
  }

  if (scope === 'entity' || scope === 'aspect') {
    return 'focused';
  }

  switch (profile.scale.scale) {
    case 'small':
      return 'complete';
    case 'medium':
      return 'modules';
    case 'large':
    case 'huge':
      return 'boundaries';
  }
}

export interface StrategyInput {
  readonly profile: RepositoryProfile;
  readonly scope: QuestionScope;
  readonly intent: QuestionIntent;
  /** The subsystem the question named, already confirmed against the profile. See `focusOf`. */
  readonly focus?: string | null;
  /**
   * What the answer leads with, where the planner has decided it.
   *
   * Read for the one thing scope cannot express: how broad the *question* is, as opposed to how much of
   * the repository it reaches. Omitted, depth behaves exactly as it did before the planner existed, which
   * is what a caller inspecting a strategy without a plan should get.
   */
  readonly lead?: string;
}

export function strategyFor(input: StrategyInput): ExplanationStrategy {
  const { profile, scope, intent } = input;
  const depth = depthOf(profile, scope, input.lead);
  const type = TYPE_FOCUS[profile.type.value];
  const focus = input.focus ?? null;

  const cover =
    depth === 'focused'
      ? focusedCover(focus, intent)
      : // A huge repository gets the boundary-level half of its type's coverage rather than all of it:
        // the later entries in every list are the detail ones, and instructing a model to cover detail
        // it cannot be given facts for is what produces confident, unsupported prose.
        profile.scale.scale === 'huge'
        ? type.cover.slice(0, 2)
        : type.cover;

  // Deduplicated against what the type already asked for. A framework's own list opens with its
  // extension points, and the `plugin-oriented` trait would otherwise ask for them a second time in
  // slightly different words — which reads to a model as two requirements rather than one.
  const additional = traitCoverage(profile.traits, depth).filter(
    (line) => !cover.some((existing) => overlaps(existing, line)),
  );

  return {
    depth,
    opening: depth === 'focused' && focus !== null ? `Open with what ${focus} is for in this repository.` : type.opening,
    cover: [...cover, ...additional, ...domainCoverage(profile.domains, depth)],
    avoid: [...type.avoid, ...(depth === 'focused' ? ['do not explain the repository as a whole'] : [])],
    closing: DEPTH_RULES[depth].closing,
    focus,
  };
}

/**
 * Whether two coverage lines are asking for the same thing.
 *
 * Compared on the distinctive noun phrase rather than by string equality, because the two sources word
 * the same requirement differently — "the extension points — plugins, adapters, presets" against "the
 * extension points, and what a consumer plugs into them".
 */
function overlaps(left: string, right: string): boolean {
  const head = (line: string): string => (line.split(/[,—-]/)[0] ?? line).trim().toLowerCase();

  return head(left) === head(right);
}

/** What a subsystem question wants, which is the same four things whatever the subsystem is. */
function focusedCover(focus: string | null, intent: QuestionIntent): readonly string[] {
  const subject = focus ?? 'the subject of the question';

  return [
    `what ${subject} is responsible for`,
    `what reaches ${subject}, and what ${subject} reaches`,
    `where ${subject} sits in the architecture — one sentence, not a tour`,
    ...(intent === 'caching' || intent === 'security' ? [`what ${subject} is keyed on or guards`] : []),
  ];
}

/**
 * Coverage a structural trait adds, above what the type already asked for.
 *
 * Only traits that *change what is worth saying* appear. `multi-package` does not: an answer about a
 * multi-package repository is already going to name packages. `plugin-oriented` does, because extension
 * points are the thing a reader of such a repository is actually looking for and nothing else in the
 * instruction would have asked for them.
 */
function traitCoverage(traits: readonly TraitClaim[], depth: ExplanationDepth): readonly string[] {
  if (depth === 'focused') {
    return [];
  }

  const has = (trait: ComplexityTrait): boolean => traits.some((claim) => claim.trait === trait);
  const lines: string[] = [];

  if (has('multi-service')) {
    lines.push('the separate services in this repository and what each one owns');
  }

  if (has('plugin-oriented') && !has('compiler-pipeline')) {
    lines.push('the extension points, and what a consumer plugs into them');
  }

  if (has('cyclic') && depth !== 'boundaries') {
    lines.push('where the module graph is circular, and between which parts');
  }

  return lines;
}

/**
 * Coverage a domain adds.
 *
 * Capped, and capped low. The domains are ranked by how much evidence named them, so the first three
 * are the ones the repository is most visibly organised around; instructing a model to cover eleven
 * domains would produce a paragraph per domain and no architecture at all — the failure this milestone
 * exists to fix, wearing different clothes.
 */
function domainCoverage(domains: readonly DomainClaim[], depth: ExplanationDepth): readonly string[] {
  if (depth === 'focused' || domains.length === 0) {
    return [];
  }

  const named = domains.slice(0, 3).map((claim) => claim.domain);

  return [`what the code does about ${named.join(', ')} — the domains it is most visibly organised around`];
}

/**
 * The repository half of the guidance: what this repository is, and how far an answer about it may reach.
 *
 * **Rendered from the profile and the scale alone — never from the question.** It goes into the system
 * message, ahead of a fact block that on a large repository runs to thousands of tokens, so it must be
 * byte-identical between two questions about the same repository or the provider re-evaluates the whole
 * prefix on every turn. `questionGuidance` carries everything that varies.
 *
 * It states the type and the shape as *given*, because the projection also emits them as citable facts:
 * the model is told what the repository is here so it can build an answer around it, and given the fact
 * ids there so it can cite it. Neither half would be enough alone.
 */
export function repositoryGuidance(profile: RepositoryProfile, identity?: RepositoryIdentity): string {
  const lines: string[] = ['This repository, from the facts below:'];

  /*
   * The purpose leads, ahead of the type.
   *
   * "It is a service" is a category; "it is a service organised around url and analytics, exposing
   * /:shortCode" is what the repository *does*, and a model that reads the second first writes an
   * opening sentence about the system rather than about its shape. The type still follows, because the
   * explanation strategy below is chosen by it and an instruction whose premise is unstated reads as
   * arbitrary.
   */
  /*
   * What the directory map says, first, wherever the map says something the declarations cannot.
   *
   * **The order matters most on the repositories the declarations mislead about.** An umbrella of git
   * submodules has no purpose the graph can assemble and no type it can defend, so the guidance opened
   * "What kind of project this is could not be established" and the model built an answer out of the only
   * thing it had — four CI scripts. The category is derived from the top-level map rather than from
   * declarations, so it is available precisely when everything else is not, and it is the first thing a
   * reader needs to know.
   */
  if (identity !== undefined && identity.category !== 'unknown' && identity.category !== 'codebase') {
    lines.push(`  It is a ${identity.category} repository: ${identity.categoryEvidence.join('; ')}.`);

    const named = identity.areas
      .filter((area) => area.name !== '')
      .slice(0, 6)
      .map((area) => `${area.name} (${area.role}, ${area.files} files${area.declarations === 0 ? '' : `, ${area.declarations} declarations`})`);

    if (named.length > 0) {
      lines.push(`  Its top-level areas: ${named.join('; ')}.`);
    }
  }

  if (identity?.purpose != null) {
    lines.push(`  It is ${identity.purpose.value}.`);

    if (identity.users !== null && identity.users.value !== '') {
      lines.push(`  Used by ${identity.users.value}.`);
    }
  } else if (profile.type.value !== 'unknown') {
    lines.push(`  It is ${article(profile.type.value)} ${profile.type.value}. ${sentence(profile.type.evidence)}`);
  } else {
    lines.push('  What kind of project this is could not be established from the graph. Do not assert one.');
  }

  const traits = profile.traits.map((claim) => claim.trait);

  if (traits.length > 0) {
    lines.push(`  Its shape: ${traits.join(', ')}.`);
  }

  if (profile.stack.length > 0) {
    lines.push(
      `  Its stack: ${profile.stack.map((entry) => `${entry.value} (${entry.evidence.join(', ')})`).join('; ')}.`,
    );
  }

  /*
   * Domains with their members, and ranked, where the identity could weigh them.
   *
   * A bare list of domain names is the inventory this milestone exists to replace. Naming the
   * declarations that carry each one, in importance order, is what lets an answer be *about* url
   * rather than about the six controllers that happen to exist — and the ordering is the same measured
   * fan-in the ranking rests on, so the emphasis is evidence rather than emphasis.
   */
  if (identity !== undefined && identity.domains.length > 0) {
    lines.push('  Organised around, most significant first:');

    for (const domain of identity.domains.slice(0, 5)) {
      const members = domain.members.length === 0 ? '' : ` — ${domain.members.slice(0, 4).join(', ')}`;

      lines.push(`    ${'★'.repeat(domain.stars)}${'☆'.repeat(5 - domain.stars)} ${domain.name}${members}`);
    }
  } else if (profile.domains.length > 0) {
    lines.push(`  Domains it is organised around: ${profile.domains.slice(0, 6).map((claim) => claim.domain).join(', ')}.`);
  }

  lines.push(
    '',
    'How to explain it:',
    `  ${DEPTH_RULES[depthOf(profile, 'whole')].instruction}`,
  );

  const strategy = strategyFor({ profile, scope: 'whole', intent: 'overview' });

  lines.push(`  ${strategy.opening}`, '  Then cover, in this order:');

  for (const item of strategy.cover) {
    lines.push(`    - ${item}`);
  }

  for (const item of strategy.avoid) {
    lines.push(`  Do not: ${item.replace(/^do not /, '')}`);
  }

  /*
   * The repository-first constraint, stated once and for every repository.
   *
   * **This is the generic replacement for a class of failure that was previously fixed one repository at a
   * time.** Given an umbrella of git submodules whose only analysable code is four CI scripts, a model
   * handed a fan-in ranking wrote that `set_secret.py` was the repository's core — and every number behind
   * that sentence was correct. The same shape recurs wherever the richest local evidence is not the
   * repository's subject: a monorepo's largest package is not its architecture, a template repository's CI
   * is not its purpose, and a documentation repository's build script is not what it is for.
   *
   * The facts that establish a repository-level relationship are named rather than gestured at, because a
   * prohibition a model cannot check is a prohibition it will reason around. Each of the four is a
   * predicate the projection either carries or does not.
   *
   * It sits in the repository half rather than the question half deliberately: it is a function of nothing
   * but the repository, so it stays inside the cacheable prefix and costs no tokens on a follow-up.
   */
  lines.push(
    '',
    'On every repository-level statement:',
    '  The most analysed directory, the highest-ranked component, a CI directory and a hotspot are not this',
    '  repository’s architectural centre, purpose or starting point unless a repository-level fact says so —',
    '  what it exists',
    '  to do, a capability, a request flow, a workflow, a route it serves, an entry point. A fan-in or a file',
    '  count says only that something is structurally prominent, which is what you may say about it. Where',
    '  the facts do not settle what the repository is, say so rather than promoting the best-measured part.',
  );

  return lines.join('\n');
}

/**
 * The question half: how far *this* question reaches, and what it is about.
 *
 * Rendered after the question, where varying it costs nothing. It **overrides** the repository guidance
 * where the two disagree, and says so in as many words — a focused question inside a large repository
 * has to defeat an instruction to start from the subsystem boundaries, and a model given two
 * instructions without a precedence rule will average them.
 */
export function questionGuidance(strategy: ExplanationStrategy, plan?: AnswerPlan): string {
  const lines: string[] = [];

  /*
   * What the reader needs, before what the answer must do.
   *
   * **This is the sentence the milestone turns on.** A model told "explain the architecture" writes an
   * architecture overview whatever else it is asked; a model told "the reader is new to this repository
   * and needs an ordered path into it, not an inventory" writes something else entirely — from the same
   * facts, at the same depth, under the same citation rule. Everything below it is a constraint; this
   * is the objective.
   */
  if (plan !== undefined) {
    /*
     * Where the repository does not hold what was asked about, that *is* the answer.
     *
     * **First, before the need line, and it replaces the section list rather than joining it.** Given a
     * caching question about a repository with no cache, the planner used to hand the model a full
     * structure — sections, components, a need line asking it to explain the caching strategy — plus
     * sixty facts about something else, and a model told to explain caching and given no cache explains
     * whatever it was given. Three paragraphs about CI scripts is a worse answer than one sentence saying
     * no caching was identified, and the sentence is the true one.
     *
     * The three verdicts get three different instructions, and the difference between the last two is the
     * whole reason there are three: absence is a claim about the repository, and an analysis that could
     * not have seen the thing may not make it.
     */
    if (plan.sufficiency.verdict !== 'established') {
      lines.push(
        plan.sufficiency.verdict === 'absent'
          ? `The analysis did not identify ${plan.sufficiency.concept} in this repository: ${plan.sufficiency.detail}.`
          : `Whether this repository has ${plan.sufficiency.concept} could not be determined: ${plan.sufficiency.detail}.`,
        'Answer the question that was asked, in two or three sentences, by saying exactly that and citing the facts that support it.',
        plan.sufficiency.verdict === 'absent'
          ? 'Say the analysis did not identify it — not that the repository does not have it. Those are different claims and only the first is yours to make.'
          : 'Name the limit of the analysis. Do not present it as a finding about the repository.',
        'Do not describe the repository’s other parts to fill the answer out. A short true answer is the right answer here; length is not.',
        '',
      );
    }

    lines.push(`What the reader needs: ${plan.need}`);

    const assumption = AUDIENCE_ASSUMPTION[plan.audience];

    if (assumption !== '') {
      lines.push(assumption);
    }

    /*
     * That the question has more than one part, where it has.
     *
     * The parts are stated and the merge is demanded in the same breath, because the failure this
     * fixes has two halves: a model that reads "explain authentication and how JWT works" as one
     * question answers the first and mentions the second, and a model told to answer two questions
     * writes two answers with two openings. Naming both and requiring one explanation is what produces
     * the thing the reader asked for.
     */
    if (plan.tasks.length > 1) {
      lines.push(
        '',
        `This question has ${plan.tasks.length === 2 ? 'two' : 'several'} parts. Cover all of them, in one explanation rather than one after another:`,
      );

      for (const task of plan.tasks) {
        lines.push(`  - ${task.question}`);
      }
    }

    /*
     * The shape of the answer.
     *
     * **The one instruction that differs between two repositories given the same question**, and the
     * reason it is a list rather than a paragraph is that a model follows an order it can count. Each
     * section here survived the evidence check in `plannedSections`, so nothing in this list is a
     * paragraph the facts cannot support — which is what makes it safe to demand all of them.
     */
    if (plan.sections.length > 0 && plan.sufficiency.verdict === 'established') {
      lines.push('', 'Build the answer in this order, as continuous prose rather than as headed parts:');

      plan.sections.forEach((section, index) => {
        lines.push(`  ${index + 1}. ${section.title} — ${section.purpose}`);
      });
    }

    /*
     * The workflows, spelled out, because a model will not reconstruct one from the facts.
     *
     * The chain is already in the fact block as a `workflow` line, and repeating it here is not
     * redundancy — the fact is evidence the model may cite, and this is an instruction to *build the
     * answer around it*. A model given the fact alone reports it among the others.
     */
    if (plan.workflows.length > 0) {
      lines.push('', 'Narrate these, in this order — they are what this repository does:');

      for (const workflow of plan.workflows) {
        lines.push(`  ${renderWorkflowBrief(workflow)}`);
      }
    }

    /*
     * The route, for an orientation question — and the ranked components for every other kind.
     *
     * **Never both.** A route is the same units and declarations the ranking would have listed, put in
     * the order a reader can absorb them rather than the order they scored in, and printing the two
     * lists side by side would spend the tokens twice to give the model two conflicting orderings of
     * one set of names. The route wins where it exists, because "where do I start" is a question about
     * order and the ranking is not an answer to it.
     */
    if (plan.navigation.length > 0) {
      lines.push('', 'Give this route, in this order, and say why each step follows the last:');

      for (const step of plan.navigation) {
        lines.push(`  ${step.stage}: ${step.target} — ${step.why}`);
      }
    } else if (plan.components.length > 0 && plan.sufficiency.verdict === 'established') {
      lines.push(
        '',
        'Spend the most space on these, in this order. The stars are how much of the repository points at each:',
      );

      /*
       * The rank and the strongest reason for it, and nothing else.
       *
       * **The evidence lives in the facts, not here.** Every one of these components is also emitted
       * as a `ranks` fact carrying all of its signals, which is what the model cites. Repeating the
       * full signal list in the instruction cost 475 tokens on Spring PetClinic — a seventh of the
       * whole fact budget — to say twice what the facts already said once. The instruction only has to
       * establish the *order*; the evidence for it is a citation away.
       */
      for (const component of plan.components.slice(0, 6)) {
        const reason = component.signals[0]?.detail ?? '';

        lines.push(
          `  ${'★'.repeat(component.stars)}${'☆'.repeat(5 - component.stars)} ${component.name}${reason === '' ? '' : ` (${reason})`}`,
        );
      }
    }

    /*
     * What earlier turns already covered.
     *
     * Subtractive, and phrased so: a model told a name is already explained still has every fact about
     * it and may still cite them. What changes is that the follow-up spends its length on what was
     * asked rather than on re-establishing the ground the conversation already stands on.
     */
    /*
     * That this question is a continuation, and what it is a continuation of.
     *
     * **The reader said "this"; the model has to say what "this" is.** A follow-up whose subject came
     * from the session rather than from the sentence produces an answer that reads as a reply to a
     * message the reader can no longer see, unless it opens by naming the thing. Which is also the
     * answer-independence rule below, arriving from the other direction.
     */
    if (plan.continues && plan.focus !== null) {
      lines.push(
        '',
        `This question continues the session and does not name its own subject: it is about ${plan.focus}. Open by naming it, then answer what was actually asked about it.`,
      );
    }

    /*
     * What the session already covered, and the standing rule that an answer still stands alone.
     *
     * **The two are one instruction, and separating them was a mistake worth not repeating.** Told only
     * "already explained: urlService", a model writes "as explained above, urlService…" and produces an
     * answer that is unreadable on its own — which is exactly what a user scrolling back to one answer
     * wants least. Told only to stand alone, it re-explains everything and the session goes in circles.
     * Naming a thing is cheap; re-deriving it is what the session already paid for.
     */
    if (plan.covered.length > 0) {
      lines.push(
        '',
        `Already explained in this session: ${plan.covered.join(', ')}. Name them where this answer needs them, but do not explain them again.`,
        'Write this answer so it stands on its own. Never refer to an earlier answer, and never write "as explained above" or "as mentioned earlier" — the reader may be reading only this one.',
      );
    }

    /*
     * Where to send a reader who is asking to be led, from what the session has not reached.
     *
     * The depth rules already ask a boundaries-level answer to close by naming what to ask about next,
     * and until the session had a memory that closing was a guess. These are the parts of the
     * repository this particular reader has not had explained, which is a different list for every
     * session over one repository.
     */
    if (plan.suggested.length > 0) {
      lines.push(
        '',
        `This session has not reached ${plan.suggested.join(', ')}. Close by pointing at whichever of those this answer makes the natural next question.`,
      );
    }

    /*
     * What to leave alone, and what cannot be answered.
     *
     * Both are one line each and both are late, immediately before the depth rule, because they are
     * boundaries rather than objectives — a model given a prohibition early treats it as a topic. The
     * exclusions name only concepts the repository demonstrably has, so neither line can introduce
     * something for the answer to invent. See `exclusionsFor` and `plannedSections`.
     */
    if (plan.exclusions.length > 0) {
      lines.push('', `Not this answer's subject: ${plan.exclusions.join(', ')}. Mention one only if the question cannot be answered without it.`);
    }

    if (plan.unknowns.length > 0) {
      lines.push(
        `The facts do not settle: ${plan.unknowns.slice(0, 2).join('; ')}. Say so plainly where it matters, and do not fill the gap.`,
      );
    }

    lines.push('');
  }

  if (strategy.depth === 'focused') {
    lines.push(
      `This question is about one part of the repository${strategy.focus === null ? '' : ` — ${strategy.focus}`}. That overrides the repository-wide instruction above.`,
      DEPTH_RULES.focused.instruction,
    );

    /*
     * The coverage list, only where no plan supplied a section order.
     *
     * The two say the same thing in different words — "what UrlService is responsible for" against "what
     * UrlService is for: its responsibility, and only its own" — and a model given both reads two
     * requirements where there is one. The plan's version is the one that was checked against the
     * evidence, so it is the one that survives.
     */
    if (plan === undefined || plan.sections.length === 0) {
      lines.push('Cover:');

      for (const item of strategy.cover) {
        lines.push(`  - ${item}`);
      }
    }
  } else {
    lines.push(DEPTH_RULES[strategy.depth].instruction);
  }

  if (strategy.closing !== null) {
    lines.push(strategy.closing);
  }

  return lines.join('\n');
}

/**
 * What each audience lets the answer take as read.
 *
 * **One line each, and the default is silence.** `engineer` is the majority of questions and it is also
 * the assumption the standing instruction already encodes — "an engineer who has just been handed this
 * repository" — so saying it again would spend tokens restating the default. The other three are
 * departures from it, and each one changes what the first paragraph has to establish before it can say
 * anything.
 */
const AUDIENCE_ASSUMPTION: Readonly<Record<Audience, string>> = {
  newcomer:
    'The reader has not seen this repository before. Name a thing before you rely on it, and prefer this repository’s own words to general ones.',
  contributor:
    'The reader intends to change this code. Say where a change of this kind would go, in the files and declarations the facts name.',
  specialist:
    'The reader already knows this repository has this part. Do not re-explain the surrounding architecture; place it in one sentence and spend the rest on the subject.',
  engineer: '',
};

/**
 * `a` or `an`.
 *
 * A one-line fix for a defect visible in every prompt LinkForge produced — "It is a application" — and
 * worth fixing rather than tolerating: the guidance is the sentence the model is told to build its
 * answer around, and prose that reads as broken is prose a model is more likely to paraphrase than to
 * follow. The type vocabulary is a closed set of eleven words, so a vowel test is exactly sufficient.
 */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** Evidence as one sentence, so the guidance reads as prose rather than as a list of clauses. */
function sentence(evidence: readonly string[]): string {
  if (evidence.length === 0) {
    return '';
  }

  const text = evidence.join('; ');

  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
