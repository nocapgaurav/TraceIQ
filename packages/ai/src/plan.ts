import type { ConversationState } from './memory.js';
import { NO_STATE } from './memory.js';
import type { RepositoryIdentity } from './identity.js';
import type { ComponentImportance } from './importance.js';
import type { RegionRole } from './structure.js';
import { focusOf, intentOf, scopeOf, type QuestionIntent, type QuestionScope } from './intent.js';
import { subsystemsOf } from './profile.js';
import { strategyFor, type ExplanationDepth, type ExplanationStrategy } from './strategy.js';
import type { Workflow } from './workflow.js';

/**
 * What this particular question actually needs, decided before a single fact is chosen.
 *
 * **The order of operations is the milestone.** Until now the pipeline asked "what facts fit the
 * budget" and then rendered whatever survived; the intent reordered the supplement and the strategy
 * shaped the instruction, but nothing ever asked *what the reader wants*. So "where should I start?"
 * and "explain the architecture" produced the same projection, because both are `architecture` intent
 * and the same size of repository.
 *
 * A plan is the answer to that question, and it is composed from things that already exist rather than
 * from a new opinion: the identity says what the repository is and what matters in it, the scope says
 * how far the question reaches, the intent says what kind of facts it wants, and the strategy says how
 * deep an answer of this size may go. What the plan adds is the **selection** — which workflows, which
 * components, which domains a reader actually needs for *this* question — the `need` line, which is
 * the sentence the whole answer is built to satisfy, and the `sections`, which are the shape the answer
 * is poured into.
 *
 * **Nothing here loosens grounding.** A plan selects among things the identity already proved; it
 * cannot introduce a component the ranking did not rank or a workflow the graph did not support. A
 * question about a subsystem the repository does not have selects nothing and falls back to the
 * repository-wide plan, which is the same safe direction `scopeOf` already fails in. A section whose
 * evidence the identity does not carry is **dropped and recorded as an unknown** rather than asked for:
 * a heading with nothing under it is how a model is invited to fill the gap itself.
 *
 * **Everything here is deterministic and free.** No second model call decides any of it, for the three
 * reasons `intentOf` gives — reproducibility, cost, and being safe when wrong — and the same escape
 * applies: every selection below either narrows something the identity proved or falls back to the
 * repository-wide default. The whole plan is derived in well under a millisecond and cached against the
 * identity it was planned from, so the four consumers that read it derive it once. See `CACHE`.
 */

/**
 * What an answer should lead with.
 *
 * Distinct from `ExplanationDepth`, which says how *much* to explain. This says what the first
 * paragraph is *about*, and the two are independent: a small library and a huge one both lead with
 * their public surface, and a small service and a huge service both lead with a workflow.
 */
export const ANSWER_LEADS = [
  /** A thing that happens, traced end to end. */
  'workflow',
  /** What a consumer imports and calls. */
  'api',
  /** Where someone else's code plugs in. */
  'extension-points',
  /** What goes in, what comes out, and the stages between. */
  'pipeline',
  /** What it does when someone runs it. */
  'commands',
  /** What is built, shipped and run. */
  'deployment',
  /** The units, ranked, for a repository too large to narrate. */
  'components',
  /** One named subsystem and its place in the whole. */
  'subsystem',
  /** An ordered path through the repository for someone new to it. */
  'orientation',
  /**
   * Where to look: which files, which tests, which component owns a thing.
   *
   * **A different kind of answer from every other lead, and its absence was a measured failure.** Asked
   * "what tests should I read first?", TraceIQ produced an architecture overview — correct, cited, and
   * useless, because the reader wanted filenames. A locating answer names things a reader can open and
   * says why each one; it is not a description of the repository with paths in it.
   */
  'locate',
] as const;

export type AnswerLead = (typeof ANSWER_LEADS)[number];

/**
 * Who the answer is being written for, inferred from how the question is asked.
 *
 * **Inferred from the question's *form*, never from the reader — this layer has never met them.** What
 * it actually classifies is how much the question already knows: "what does this project do" states
 * that the asker knows nothing about the repository, and "explain Fiber scheduling" states that they
 * know enough to name an internal subsystem. Both are properties of the sentence.
 *
 * It steers **assumption, not depth**. Depth is the scale rule's decision and audience must not
 * override it, or a newcomer asking about a huge repository would be handed the complete walkthrough
 * that the depth rule has just established the facts cannot support. What this changes is what the
 * answer takes as read: a specialist is not told what a controller is, and a newcomer is not handed a
 * subsystem name with no anchor to the repository around it.
 */
export const AUDIENCES = [
  /** Has not seen this repository, and possibly not this kind of repository. */
  'newcomer',
  /** Intends to change it, and needs to know where the change goes. */
  'contributor',
  /** Knows the domain, does not know this codebase. The default. */
  'engineer',
  /** Named an internal subsystem, so already knows this codebase has one. */
  'specialist',
] as const;

export type Audience = (typeof AUDIENCES)[number];

/**
 * How sure the planner is that it read the question correctly.
 *
 * **Reported rather than acted on**, and that restraint is the point. A plan the planner is unsure of
 * is still the best plan available, and answering something narrower on low confidence would turn an
 * imprecise reading into a wrong answer. What it is for is diagnosis: when an answer is shaped wrongly,
 * this says whether the planner thought it knew what it was doing.
 */
export const PLAN_CONFIDENCES = [
  /** The subject was resolved by the caller, or the question named a subsystem the repository has. */
  'certain',
  /** The question matched an explicit pattern — an orientation question, a responsibility intent. */
  'likely',
  /** Nothing in the question was distinctive; the plan is this repository's default shape. */
  'uncertain',
] as const;

export type PlanConfidence = (typeof PLAN_CONFIDENCES)[number];

/**
 * One part of the answer, in the order it should be written.
 *
 * **The section list is the "no fixed template" requirement made concrete.** An architecture answer and
 * a bug answer are not one template with different content; they are different sequences of different
 * questions, and until the sequence was data there was no way to have more than one of them.
 *
 * It is also the progressive disclosure: the first section of every list is one paragraph that stands
 * alone, and each one after it descends a level. A reader who stops after the first has an answer.
 */
export interface PlanSection {
  /** What the section establishes, as a phrase — never rendered as a heading. See `SYSTEM_PROMPT`. */
  readonly title: string;
  /** What it must actually say, in one short clause. */
  readonly purpose: string;
  /**
   * Identity fields this section cannot be written without.
   *
   * **The evidence rule, enforced rather than stated.** A section is emitted only where every field
   * here is one the identity actually carries; where it is not, the section is dropped and named in
   * `unknowns`. That is the difference between "the facts do not settle this" appearing in the answer
   * and a model quietly writing the paragraph anyway.
   */
  readonly requires: readonly string[];
  /** Fact parts that carry the evidence, so the projection can be asked for them. */
  readonly evidence: readonly string[];
}

/** One step of a route into the repository, for a reader who has not opened it yet. */
export interface NavigationStep {
  readonly stage: 'start here' | 'then read' | 'then inspect' | 'finally';
  readonly target: string;
  readonly why: string;
}

/**
 * One askable part of a compound question.
 *
 * **Emitted only where the question genuinely has more than one.** "Explain authentication and how JWT
 * works" is two questions sharing a sentence, and a model that reads it as one answers the first and
 * mentions the second — which is how a correct answer still fails the person who asked it.
 */
export interface PlanTask {
  readonly question: string;
  readonly intent: QuestionIntent;
  readonly focus: string | null;
}

/**
 * The four things a fact can be about, for the purpose of dividing a budget between them.
 *
 * Coarse deliberately. The projection has twenty-four parts and a share-per-part table would be
 * twenty-four numbers nobody could defend individually; these four are the categories a reader would
 * recognise in the finished answer, which is the level at which "spend 40% on architecture" is a
 * sentence with a meaning.
 */
export const FACT_GROUPS = ['architecture', 'workflow', 'components', 'supporting'] as const;

export type FactGroup = (typeof FACT_GROUPS)[number];

/**
 * What share of the fact budget each group may take.
 *
 * **Allocation rather than a limit, and the difference is the milestone's.** A cap says "no more than
 * 40 facts"; the projection already had one and it produced balanced answers to unbalanced questions,
 * because the parts that ran first took whatever they wanted and the rest took what was left. A share
 * says a workflow question spends 40% of its supplement on the request flow *whatever ran first*.
 *
 * Shares sum to one, and are applied to the **supplement only** — see `ProjectionOptions.allocation`.
 */
export type FactAllocation = Readonly<Record<FactGroup, number>>;


/**
 * Whether the repository actually holds what the question asked about.
 *
 * **Three states, not two, and the middle one is the point.** "There is no cache" and "no cache was
 * detected" are different claims: the first is about the repository and the second about the analysis, and
 * a system that cannot tell them apart must either overclaim or stay silent. TraceIQ can tell them apart
 * because it knows what it looked for and what it can see.
 */
export const EVIDENCE_VERDICTS = [
  /** The graph carries what the question asked about. Answer it. */
  'established',
  /**
   * Nothing was found, and the analysis is capable of finding it.
   *
   * A repository with a cache declares a cache dependency or names one in configuration; the detector
   * reads both. Finding neither is evidence, and the answer may say so.
   */
  'absent',
  /**
   * Nothing was found, and the analysis could not have found it here.
   *
   * A Python region analysed to `universal` depth yields no declarations at all, so "no authentication
   * middleware" says nothing about the repository. The honest answer names the boundary rather than the
   * absence.
   */
  'undetermined',
] as const;

export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

export interface EvidenceSufficiency {
  readonly verdict: EvidenceVerdict;
  /** What the question was taken to be asking for. */
  readonly concept: string;
  /** What was looked for and what was found, in one line the answer can restate. */
  readonly detail: string;
}

export interface AnswerPlan {
  /** What the reader actually needs, in one line. The sentence the answer is built to satisfy. */
  readonly need: string;
  readonly lead: AnswerLead;
  readonly depth: ExplanationDepth;
  /** How much the question already knows, from how it was asked. */
  readonly audience: Audience;
  readonly scope: QuestionScope;
  readonly intent: QuestionIntent;
  readonly focus: string | null;
  /**
   * Whether the focus was carried from the conversation rather than named by the question.
   *
   * **The difference matters to the answer, not just to the audit.** A question that named its subject
   * may assume the reader recognises it; a question that said "this" is relying on the session to
   * supply it, and the answer has to state what it is about before it says anything about it — or it
   * reads as a reply to a message the reader can no longer see.
   */
  readonly continues: boolean;
  /** Where the session has not been yet, offered where the question is asking to be led. */
  readonly suggested: readonly string[];
  /** The workflows worth narrating for this question. Empty where none apply or none exist. */
  readonly workflows: readonly Workflow[];
  /** The components worth naming, already ranked. */
  readonly components: readonly ComponentImportance[];
  /** The domains the answer should be organised around. */
  readonly domains: readonly string[];
  /** Technologies this question needs named, drawn from the identity fields it selected. */
  readonly technologies: readonly string[];
  /** What a reader must understand before the rest of the answer means anything. */
  readonly abstractions: readonly string[];
  /** Identity fields this question needs. Names the `RepositoryIdentity` keys. */
  readonly fields: readonly string[];
  /** Fact parts the projection should bring forward. Composed with the intent's own list. */
  readonly parts: readonly string[];
  /** The shape of the answer, in the order it should be written. */
  readonly sections: readonly PlanSection[];
  /** The route into the repository. Empty unless the question asked to be oriented. */
  readonly navigation: readonly NavigationStep[];
  /** Concepts this repository has that this answer must leave alone. Never invented — see `CONCEPTS`. */
  readonly exclusions: readonly string[];
  /** What this question needs that the graph cannot supply. Space the answer must reserve. */
  readonly unknowns: readonly string[];
  /** Things earlier turns already explained. Not to be explained again. */
  readonly covered: readonly string[];
  /** The parts of a compound question. Empty where the question asks one thing. */
  readonly tasks: readonly PlanTask[];
  /**
   * Whether the repository holds what the question asked about.
   *
   * **Decided before generation, so an absence can be answered instead of papered over.** Given a caching
   * question about a repository with no cache, the projection previously returned sixty facts of unrelated
   * structure and the model — instructed to explain caching, and given no cache — explained the structure
   * instead. Three paragraphs of CI scripts is a worse answer than one sentence saying no caching was
   * identified, and the sentence is the true one.
   */
  readonly sufficiency: EvidenceSufficiency;
  /**
   * Semantic roles this question restricted its evidence to. Empty where it asked about the repository.
   *
   * Reported so a reader of the diagnostics can see *why* a component list looks the way it does — a test
   * question naming four CI scripts is a different bug from one naming none.
   */
  readonly roles: readonly RegionRole[];
  /** How the fact budget should be divided between the four groups. */
  readonly allocation: FactAllocation;
  readonly confidence: PlanConfidence;
  /** The shape decision this plan was built on. */
  readonly strategy: ExplanationStrategy;
}

/**
 * What each kind of repository leads with when the question is repository-wide.
 *
 * A restatement of the mission's own table, and deliberately so — it is the product's opinion about how
 * a kind of software should be introduced, and it belongs somewhere a reviewer can read it in one
 * screen rather than distributed through a prompt builder.
 */
const TYPE_LEAD: Readonly<Record<string, AnswerLead>> = {
  application: 'workflow',
  service: 'workflow',
  library: 'api',
  sdk: 'api',
  framework: 'extension-points',
  compiler: 'pipeline',
  cli: 'commands',
  infrastructure: 'deployment',
  monorepo: 'components',
  tooling: 'commands',
  unknown: 'components',
};

/**
 * Questions that are asking for a route through the repository rather than a description of it.
 *
 * **"Where should I start?" is not an architecture question**, though every keyword in it says it is.
 * The reader is asking to be *oriented* — given an ordered path from an entry point inwards — and an
 * architecture overview answers a question they did not ask. This is the clearest case of a question
 * whose need is invisible to intent classification, and it is why the planner exists.
 */
const ORIENTATION = /\b(where (do|should|would) (i|we|you)|start|begin|beginner|new to|onboard|learn|first thing|get up to speed|orient|look at next|read next|explore next|what next|where next)\b/i;

/** Questions asking which parts matter, which the importance ranking now answers directly. */
const IMPORTANCE = /\b(most important|important|matters|key|critical|main|core|significant|biggest|central|focus on)\b/i;

/** Questions asking what happens, rather than what exists. */
/*
 * `walk me through` was missing, and its absence cost the one question it names.
 *
 * "Walk me through one important workflow end to end" matched `IMPORTANCE` on the word `important` before
 * anything read `walk`, so the single most explicitly workflow-shaped question anyone asks was answered with
 * a ranked component list. The pattern held `walk through`, which the natural phrasing interrupts.
 */
const WORKFLOW_QUESTION =
  /\b(how does|how do|what happens|flow|lifecycle|pipeline|process|when a|end to end|walk (me |us |through)|trace)\b/i;

/** Questions asking where a kind of code lives. */
const LOCATION = /\b(where is|where are|where does|which file|which package|located|lives|find)\b/i;

/** Questions asked by someone who intends to change the code rather than to understand it. */
const CONTRIBUTION = /\b(add|adding|implement|implementing|change|changing|modify|extend|contribute|contributing|write a|hook into|plug in|where do i put)\b/i;

/**
 * Whether the question is asking to be oriented, rather than asking where a change goes.
 *
 * **`ORIENTATION` matches "where do I", and "where do I add a new route" is not an orientation
 * question.** The two overlap on the most common opening in English for asking about a repository, and
 * the difference is entirely in what follows it: one wants a path into the codebase, the other wants
 * one location and has no use for a tour. Without this guard a contributor asking where their change
 * goes was handed a five-step reading list — a correct answer to a question they did not ask, which is
 * the exact failure the planner was built to fix, wearing different clothes.
 */
function orienting(question: string): boolean {
  return ORIENTATION.test(question) && !CONTRIBUTION.test(question);
}

/** Questions that state, in the asking, that the asker knows nothing about this repository yet. */
const NOVICE = /\b(what (is|does) (this|the) (project|repo|repository|codebase|thing)|what am i looking at|explain (this|it) (to me )?(like|as)|never seen|no idea)\b/i;

/**
 * Questions that point at something the conversation has already established.
 *
 * **A pronoun, an explicitly anaphoric opener, or a fragment — and not merely a question that begins
 * with "why".** The first version anchored on the opening word, and validation showed what that costs:
 * on React, turn five's "Why is Redis used?" inherited turn four's authentication focus and was planned
 * as a question about authentication. A question that begins with `why` and then names its own subject
 * is not a continuation; one that begins with `why` and names nothing is.
 *
 * The three conditions in order: a deictic pronoun ("where is *this* implemented?", "why was *it*
 * chosen?"), an opener that can only refer backwards ("what about…"), or a question short enough to be
 * a fragment. Three words is the fragment bar, and it is safe because a three-word question that named
 * a subsystem has its own focus already and never reaches this.
 */
const DEICTIC = /\b(this|that|it|its|it's|they|them|these|those|there|the same|above|earlier|previously)\b/i;

const ANAPHORIC = /^\s*(and|but|so|then|also|what about|how about|what else|ok|okay)\b/i;

function pointsBack(question: string): boolean {
  const words = question.trim().split(/\s+/).filter((word) => word !== '').length;

  return DEICTIC.test(question) || ANAPHORIC.test(question) || words <= 3;
}

/**
 * Questions that have re-widened to the whole repository, whatever else they say.
 *
 * **The guard that stops the inheritance running away with a session.** "What does this repository do?"
 * contains `this`, names no subsystem — `repository` is question vocabulary, not an answer — and at
 * turn nine would otherwise inherit whatever the last question was about and be answered as a question
 * about authentication. A question that says `repository`, `codebase` or `overall` has told you its
 * scope, and it is not the last topic.
 */
const REPOSITORY_WIDE = /\b(repository|repo|project|codebase|whole|entire|overall|everything|architecture|overview)\b/i;

/**
 * The focus a follow-up is relying on the session to supply.
 *
 * Three conditions, all necessary. There must be a session focus to inherit; the question must not have
 * re-widened; and it must actually point at something — a question that simply names nothing has
 * changed the subject rather than continued it, and "how are errors handled?" after an authentication
 * answer is a new question about errors, not a question about authentication.
 */
function inherited(question: string, state: ConversationState): string | null {
  if (state.focus === null || REPOSITORY_WIDE.test(question) || !pointsBack(question)) {
    return null;
  }

  return state.focus;
}

/**
 * Where to point a reader next, from what the session has not reached.
 *
 * **Offered only to the questions that are asking to be led.** An orientation question ends by naming
 * what to look at next — the depth rules already ask for that — and until now the answer had to guess,
 * because nothing told it which parts of the repository this reader had already had explained. Every
 * other question gets none: a caching question closing with "you might also look at deployment" is a
 * suggestion nobody asked for.
 */
function suggestedFor(lead: AnswerLead, state: ConversationState): readonly string[] {
  return lead === 'orientation' || lead === 'components' ? state.remaining.slice(0, 3) : [];
}

export interface PlanInput {
  readonly identity: RepositoryIdentity;
  readonly question: string;
  /** The context kind, so an already-resolved subject is respected. */
  readonly kind: string;
  /**
   * What the conversation has established, where there is one.
   *
   * **A state rather than a transcript, and the substitution is a whole milestone.** The planner used
   * to read the turns directly and scan their answers for names it recognised, which meant every
   * consumer of a plan re-derived the same scan and the reservation grew with the prose. `deriveState`
   * does it once, bounded, and hands back the four things a plan can actually use.
   *
   * **It subtracts and it steers; it never adds a topic.** `covered` removes explanations the session
   * already gave, and `focus` supplies a subject to a question that named none — the two operations a
   * follow-up needs. Neither can put something in an answer that the current question did not ask for.
   */
  readonly state?: ConversationState;
}

/**
 * Plans already made, by identity and question.
 *
 * **Two levels, because the two inputs have different lifetimes.** The identity is derived once per
 * `RepositoryContext` and held weakly there, so keying the outer map on it means a plan dies with the
 * context it was planned against and nothing holds a megabyte of graph alive. The inner key is the
 * question plus the history, which is what actually varies within one request — and within one request
 * the answerer plans four times: once to reserve the budget, once to project, once to assemble, once to
 * report the shape.
 *
 * Bounded, because a long-lived context serving a long conversation would otherwise accumulate one
 * entry per question ever asked about it. The bound is generous relative to a conversation and trivial
 * relative to the context it hangs off.
 */
const CACHE = new WeakMap<RepositoryIdentity, Map<string, AnswerPlan>>();

const CACHE_LIMIT = 64;

export function planFor(input: PlanInput): AnswerPlan {
  const held = CACHE.get(input.identity) ?? new Map<string, AnswerPlan>();
  // The state's own two fields, because the state is already the compressed form of the conversation.
  // Two sessions that covered the same topics and are focused on the same thing plan one question
  // identically, whether either took four turns to get there or forty.
  const key = [
    input.kind,
    input.question,
    input.state?.focus ?? '',
    (input.state?.covered ?? []).map((topic) => topic.name).join(','),
    input.state?.level ?? '',
  ].join('\u0000');
  const cached = held.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const plan = compose(input);

  if (held.size >= CACHE_LIMIT) {
    held.clear();
  }

  held.set(key, plan);
  CACHE.set(input.identity, held);

  return plan;
}

function compose(input: PlanInput): AnswerPlan {
  const { identity, question } = input;
  const state = input.state ?? NO_STATE;
  const subsystems = subsystemsOf(identity.profile);
  const scopeInput = { question, kind: input.kind, subsystems };
  const own = scopeOf(scopeInput) === 'entity' ? null : focusOf(scopeInput);
  const carried = own === null ? inherited(question, state) : null;
  const focus = own ?? carried;

  /*
   * An inherited focus narrows the scope, exactly as a named one does.
   *
   * `scopeOf` reads the question alone and cannot see that "where is this implemented?" is about the
   * redirect workflow. Recomputing the scope from the focus the planner actually resolved is what makes
   * the depth rule, the section template and the exclusions all agree that this is a question about one
   * part of the repository — and without it a follow-up would be planned as a repository-wide question
   * whose focus happened to be set.
   */
  const scope = focus === null ? scopeOf(scopeInput) : scopeOf(scopeInput) === 'entity' ? 'entity' : 'aspect';
  const intent = intentOf(question);

  /*
   * The lead is decided before the strategy, because depth now reads it.
   *
   * `leadOf` depends only on the question, the scope, the intent and the focus — never on the strategy —
   * so the reordering is free. What it buys is that how broad the *question* is can reach the depth rule,
   * which is what stops a four-filename answer being given the instruction for a repository tour.
   */
  const lead = leadOf(input, scope, intent, focus);
  const strategy = strategyFor({ profile: identity.profile, scope, intent, focus, lead });
  const roles = (lead === 'locate' ? rolesForLocating(question) : (INTENT_ROLES[intent] ?? null)) ?? [];
  const workflows = workflowsFor(identity, lead, focus, intent);
  const ranked = componentsFor(identity, lead, focus, strategy.depth, intent, question);
  const sufficiency = sufficiencyOf(identity, intent, lead, question, ranked);

  /*
   * An answer that cannot be given names nothing.
   *
   * **The padding this milestone set out to remove, closed at the source rather than in the renderer.**
   * Asked how caching works on a repository with no cache, the planner returned the repository's default
   * component ranking — its most-referenced declarations, about something else entirely — and the answer
   * was three paragraphs of them. The guidance already suppressed the list; carrying it in the plan meant
   * the reported shape still claimed six components for an answer that used none.
   *
   * A **role-restricted** question keeps whatever its role produced, and that exception is not a
   * loophole. Asked what handles deployment on a repository whose deployment model no detector could
   * name, the components are the CI scripts that do it — genuinely relevant, genuinely the answer, and
   * the sufficiency verdict is about the *technology* rather than about the code. Blanking those would
   * throw away the useful half of an honest answer.
   */
  const components = sufficiency.verdict === 'established' || roles.length > 0 ? ranked : [];
  const fields = fieldsFor(lead, intent);
  const planned = plannedSections(identity, lead, intent, focus);

  return {
    need: needOf(input, lead, focus, intent),
    lead,
    depth: strategy.depth,
    audience: audienceOf(question, scope, focus, state),
    scope,
    intent,
    focus,
    continues: carried !== null,
    suggested: suggestedFor(lead, state),
    workflows,
    components,
    domains: domainsFor(identity, focus),
    technologies: technologiesFor(identity, fields),
    abstractions: abstractionsFor(identity, focus, strategy.depth),
    // The sections' own requirements are added, so an identity field a section rests on is never
    // absent from the record of what this question needed.
    fields: [...new Set([...fields, ...planned.sections.flatMap((section) => section.requires)])],
    parts: partsFor(lead, planned.sections, question),
    sections: planned.sections,
    navigation: navigationFor(identity, lead),
    exclusions: exclusionsFor(identity, lead, intent, fields, focus),
    unknowns: planned.unknowns,
    covered: state.covered.map((topic) => topic.name),
    tasks: tasksIn(question, scopeInput),
    roles,
    sufficiency,
    allocation: allocationFor(lead, strategy.depth, workflows.length > 0),
    confidence: confidenceOf(question, scope, focus, intent),
    strategy,
  };
}

/**
 * What the answer leads with.
 *
 * **The question wins over the repository wherever it says something specific**, and the order below is
 * that precedence written out. A named subsystem decides on its own; an orientation question decides on
 * its own; a repository-wide question with nothing distinctive in it falls back to what this kind of
 * repository leads with. Only the last case consults `TYPE_LEAD`, which is why a framework asked "how
 * does routing work" gets a workflow rather than a tour of its extension points.
 */
function leadOf(input: PlanInput, scope: QuestionScope, intent: QuestionIntent, focus: string | null): AnswerLead {
  const { question, identity } = input;

  // A resolved subject was chosen by the caller, and that outranks any reading of the question text.
  if (scope === 'entity') {
    return 'subsystem';
  }

  if (orienting(question)) {
    return 'orientation';
  }

  /*
   * A locating question, **before the focus check**, and the ordering is the point.
   *
   * "Where is the caching implemented?" resolves a focus, and a focus used to mean the subsystem lead —
   * whose sections are what the subject is for, what reaches it and where it sits. All three are
   * descriptions, and the reader asked for a location. The focus is still set and the locate sections
   * still name it; what changes is that the answer points at files instead of explaining a subsystem.
   */
  if (intent === 'locate') {
    return 'locate';
  }

  if (focus !== null) {
    return 'subsystem';
  }

  if (WORKFLOW_QUESTION.test(question) && identity.workflows.length > 0) {
    return 'workflow';
  }

  if (IMPORTANCE.test(question) || LOCATION.test(question)) {
    return 'components';
  }

  if (intent === 'deployment') {
    return 'deployment';
  }

  const byType = TYPE_LEAD[identity.profile.type.value] ?? 'components';

  /*
   * A repository whose type says "lead with a workflow" and which has none must not.
   *
   * The type rules can call a repository a service on evidence — routes, a backend framework — that the
   * workflow extractor cannot turn into a chain, because the framework extractor linked no handler to
   * any route. Instructing a model to narrate a workflow it was given no facts for is how confident,
   * unsupported prose gets written.
   */
  if (byType === 'workflow' && identity.workflows.length === 0) {
    return 'components';
  }

  if (byType === 'extension-points' && identity.extensionPoints === null) {
    return 'components';
  }

  return byType;
}

/**
 * The one line the whole answer is built to satisfy.
 *
 * Written as *what the reader needs*, not as what the system will do, because the two diverge and the
 * first is the useful one. It reaches the prompt verbatim: a model told "the reader is new to this
 * repository and needs an ordered path into it, not a description of it" writes something different
 * from one told to explain the architecture.
 */
function needOf(input: PlanInput, lead: AnswerLead, focus: string | null, intent: QuestionIntent): string {
  const name = input.identity.profile.type.value;

  switch (lead) {
    case 'subsystem':
      return `The reader is asking about ${focus ?? 'one part of the repository'} specifically. They need what it is for, what reaches it, and where it sits — not a description of the repository.`;
    case 'orientation':
      return 'The reader is new to this repository and needs an ordered path into it: where to start, what to read next, and why — not an inventory of what it contains.';
    case 'locate':
      return `The reader is asking where to look${focus === null ? '' : ` for ${focus}`}. They need named files, tests and declarations they can open, with one line on why each is the right place — not a description of the repository.`;
    case 'workflow':
      return 'The reader needs to understand what happens when this repository does its job, traced from the outside in.';
    case 'components':
      return intent === 'hotspots' || IMPORTANCE.test(input.question)
        ? 'The reader needs to know which parts of this repository matter most, and why each one matters.'
        : 'The reader needs the major units and what each is responsible for, with the important ones given the most space.';
    case 'api':
      return 'The reader needs to know what this library offers a caller and how the implementation behind that surface is organised.';
    case 'extension-points':
      return 'The reader needs to know what someone building on this framework writes against, and where their code plugs in.';
    case 'pipeline':
      return 'The reader needs the compilation pipeline: what goes in, what comes out, and what each stage does.';
    case 'commands':
      return 'The reader needs to know what this tool does when it is run, and how a command reaches the work it performs.';
    case 'deployment':
      return `The reader needs the deployment model of this ${name}: what is built, what is shipped, and what configuration it requires.`;
  }
}

/**
 * Which workflows this question needs.
 *
 * A focused question takes only the workflow whose domain it named; a repository-wide question takes
 * the most-used ones, capped by depth. **A `boundaries`-depth answer gets one**, because a huge
 * repository narrated through four workflows is four times the detail the depth rule just decided
 * against.
 */
function workflowsFor(
  identity: RepositoryIdentity,
  lead: AnswerLead,
  focus: string | null,
  intent: QuestionIntent,
): readonly Workflow[] {
  if (identity.workflows.length === 0) {
    return [];
  }

  if (focus !== null) {
    const matching = identity.workflows.filter(
      (workflow) =>
        workflow.domain === focus ||
        workflow.name.toLowerCase().includes(focus) ||
        workflow.steps.some((step) => step.actor.toLowerCase().includes(focus)),
    );

    return matching.slice(0, 2);
  }

  if (lead === 'workflow') {
    return identity.workflows.slice(0, 3);
  }

  // Even where a workflow is not the lead, one is worth carrying: it is the cheapest way to show how
  // the named components relate, and the components alone read as a list.
  return intent === 'overview' || lead === 'orientation' ? identity.workflows.slice(0, 1) : [];
}

/**
 * The semantic roles each intent's evidence must come from.
 *
 * **This table is the fix for "structural prominence masquerading as semantic importance".** Asked what
 * tests to read first, the planner had no way to say "test evidence"; it asked for the most prominent
 * declarations and got whatever the fan-in count returned — on one repository, four CI scripts. Asked how
 * authentication works, it got the same four, one of which manages secrets, and an authentication
 * architecture was assembled out of it.
 *
 * An intent listed here is one whose answer must come from a particular *kind* of code. Everything not
 * listed is a question about the repository's own code, which is the default and stays the default.
 * Ordering matters: the first role with any components wins, so a deployment question prefers deployment
 * code and falls back to CI rather than to controllers.
 */
const INTENT_ROLES: Partial<Readonly<Record<QuestionIntent, readonly RegionRole[]>>> = {
  deployment: ['deployment', 'ci', 'script'],
};

/**
 * The roles a locating question wants, from what it is locating.
 *
 * Separate from `INTENT_ROLES` because `locate` covers several different requests — tests, files,
 * ownership, where to change something — and they want different evidence. The test case is the one that
 * failed in the field, and it is the one that needs a role the default set excludes.
 */
function rolesForLocating(question: string): readonly RegionRole[] | null {
  if (ABOUT_TESTS.test(question)) {
    return ['test'];
  }

  if (/\b(deploy|deployment|deployed|ship|shipped|release|released|pipeline|ci|build)\b/i.test(question)) {
    return ['deployment', 'ci', 'script'];
  }

  return null;
}

/**
 * Which components this question needs named.
 *
 * The count comes from depth, which is where the "never enumerate everything" rule lives. **Which
 * components are eligible comes from the question**, which is where this milestone's fix lives: a ranking
 * is a measurement of prominence, and prominence within the wrong kind of code is not relevance. See
 * `INTENT_ROLES` and `RepositoryIdentity.byRole`.
 */
function componentsFor(
  identity: RepositoryIdentity,
  lead: AnswerLead,
  focus: string | null,
  depth: ExplanationDepth,
  intent: QuestionIntent,
  question: string,
): readonly ComponentImportance[] {
  /*
   * A question about a particular kind of code is answered from that kind of code, or from nothing.
   *
   * **Falling back to the default ranking is what produced every one of the observed failures**, so this
   * deliberately returns an empty list where the requested role has no components. An empty list is what
   * makes the evidence-sufficiency check downstream able to say the honest thing; substituting hotspots
   * is what made the model invent an answer out of them.
   */
  const wanted = lead === 'locate' ? rolesForLocating(question) : (INTENT_ROLES[intent] ?? null);

  if (wanted !== null) {
    for (const role of wanted) {
      const ranked = identity.byRole[role] ?? [];

      if (ranked.length > 0) {
        return ranked.slice(0, depth === 'complete' ? 8 : 6);
      }
    }

    return [];
  }

  if (focus !== null) {
    const matching = identity.components.filter(
      (component) =>
        component.name.toLowerCase().includes(focus) || component.id.toLowerCase().includes(focus),
    );

    return matching.slice(0, 6);
  }

  const limit = depth === 'complete' ? 10 : depth === 'modules' ? 8 : 6;

  /*
   * A repository too large to narrate is explained through its units; a small one through its
   * declarations. The distinction matters: naming eight declarations out of React's twenty-four
   * thousand tells a reader nothing about React, while naming eight of LinkForge's is most of it.
   */
  if (lead === 'components' || depth === 'boundaries') {
    return [...identity.units.slice(0, limit), ...identity.critical.slice(0, Math.max(0, limit - 4))];
  }

  return [...identity.critical.slice(0, limit), ...identity.units.slice(0, 4)];
}

/** The domains the answer should be organised around — the focused one, or the highest-weighted. */
function domainsFor(identity: RepositoryIdentity, focus: string | null): readonly string[] {
  if (focus !== null) {
    const matching = identity.domains.filter((domain) => domain.name.includes(focus) || focus.includes(domain.name));

    if (matching.length > 0) {
      return matching.map((domain) => domain.name);
    }
  }

  return identity.domains.slice(0, 4).map((domain) => domain.name);
}

/**
 * Which of the identity's `Evidenced` list fields carry technology names.
 *
 * Named here rather than inferred, because "a field whose value is a list of strings" also describes
 * the entry points and the configuration, and neither of those is a technology.
 */
const TECHNOLOGY_FIELDS: readonly (keyof RepositoryIdentity)[] = [
  'caching',
  'persistence',
  'integrations',
  'deployment',
  'testing',
];

/**
 * The technologies this question needs named.
 *
 * **Selected by the same field list that selects everything else**, so a deployment question gets Docker
 * and a caching question gets Redis without either being told about the other's. The point is not the
 * saving — these are short lists — but that naming a technology in the instruction is what makes the
 * model build a paragraph around it rather than mention it among fourteen others.
 */
function technologiesFor(identity: RepositoryIdentity, fields: readonly string[]): readonly string[] {
  const names = TECHNOLOGY_FIELDS.filter((field) => fields.includes(field)).flatMap(
    (field) => listValue(identity, field),
  );

  return [...new Set(names)].slice(0, 8);
}

/** What a reader has to understand before the rest of the answer means anything. */
function abstractionsFor(
  identity: RepositoryIdentity,
  focus: string | null,
  depth: ExplanationDepth,
): readonly string[] {
  const all = identity.abstractions?.value ?? [];

  if (focus !== null) {
    const matching = all.filter((name) => name.toLowerCase().includes(focus));

    // A focused question whose subject is not one of the top abstractions still needs the repository's
    // own vocabulary, or the subject is placed in an architecture the reader has no words for.
    return matching.length > 0 ? matching : all.slice(0, 2);
  }

  return all.slice(0, depth === 'complete' ? 5 : depth === 'modules' ? 4 : 3);
}

/**
 * Identity fields this question needs.
 *
 * **The whole identity never goes in.** It is thirty fields of evidenced prose and would cost more than
 * the facts it exists to organise; a question about deployment needs the deployment model and the
 * configuration, and pays nothing for the extension points. This is the context-selection rule from the
 * previous milestone applied one level up — the same discipline, now over semantics rather than facts.
 *
 * The field list is a **selection record**, not a rendering list: nothing prints these values into the
 * prompt, because everything in them is already a citable fact and printing it twice would buy a second
 * copy at full price. What it drives is the section evidence check, the technology selection and the
 * exclusions — the three decisions that need to know what this answer is *about*.
 */
function fieldsFor(lead: AnswerLead, intent: QuestionIntent): readonly string[] {
  const base = ['purpose', 'users'];

  switch (intent) {
    case 'security':
      return [...base, 'security', 'entryPoints', 'configuration'];
    case 'caching':
      return [...base, 'caching', 'persistence', 'configuration'];
    case 'deployment':
      return [...base, 'deployment', 'configuration', 'testing'];
    case 'technology':
      return [...base, 'persistence', 'caching', 'integrations', 'testing', 'deployment'];
    case 'hotspots':
      return [...base, 'abstractions', 'risks'];
    default:
      break;
  }

  switch (lead) {
    case 'locate':
      return [...base, 'tests', 'entryPoints', 'abstractions'];
    case 'orientation':
      return [...base, 'entryPoints', 'abstractions'];
    case 'api':
      return [...base, 'entryPoints', 'abstractions'];
    case 'extension-points':
      return [...base, 'extensionPoints', 'abstractions'];
    case 'pipeline':
      return [...base, 'entryPoints', 'abstractions'];
    case 'deployment':
      return [...base, 'deployment', 'configuration'];
    default:
      return [...base, 'entryPoints', 'persistence', 'caching'];
  }
}

/**
 * Fact parts to bring forward, on top of what the intent and the repository type already ask for.
 *
 * Named by lead rather than by intent, because the lead is the thing that decides what the answer is
 * *made of*: an orientation answer is built from entry points and packages whatever it was classified
 * as, and a workflow answer needs the routes and the layers even when the question said "technology".
 *
 * The **sections' own evidence follows**, which is what closes the loop between the structure and the
 * projection: a section that says it needs the configuration causes `environmentVariables` to be asked
 * for, so the paragraph the plan promised has facts behind it when the model reaches it.
 */
/** Locating questions that are specifically about tests, which changes what leads the evidence. */
const ABOUT_TESTS = /\b(test|tests|spec|specs|covered|covers|coverage|suite|suites)\b/i;

function partsFor(lead: AnswerLead, sections: readonly PlanSection[], question: string): readonly string[] {
  const byLead: Readonly<Record<AnswerLead, readonly string[]>> = {
    workflow: ['request-flow', 'routes', 'architecture'],
    orientation: ['packages', 'architecture-summary', 'regions'],
    components: ['packages', 'hotspots', 'architecture'],
    api: ['packages', 'externalPackages', 'architecture'],
    'extension-points': ['packages', 'regions', 'externalPackages'],
    pipeline: ['packages', 'regions'],
    commands: ['packages', 'architecture', 'environmentVariables'],
    deployment: ['technologies', 'environmentVariables', 'composition'],
    subsystem: ['architecture', 'routes', 'hotspots', 'technologies'],
    /*
     * A locating answer's evidence depends on what is being located.
     *
     * "What tests should I read first?" and "where would I implement a new route?" share a lead and want
     * different facts entirely. Leading with `tests` for both meant a question about where to add a route
     * was answered with a list of test files — the same category error as answering a test question with
     * an architecture overview, one level down.
     */
    locate: ABOUT_TESTS.test(question)
      ? ['tests', 'packages', 'architecture', 'routes']
      : ['packages', 'architecture', 'routes', 'hotspots', 'tests'],
  };

  // The lead leads, the sections follow it, and the intent's own list is applied behind both by
  // `orderedFor`. A part named twice keeps its first position, because the reordering is a stable sort
  // and the set preserves insertion order.
  return [...new Set([...byLead[lead], ...sections.flatMap((section) => section.evidence)])];
}

/**
 * The shape of the answer, and what it could not be given.
 *
 * **Two outputs from one pass, because they are the same decision seen from either side.** A section
 * survives where the identity carries its evidence and is dropped where it does not, and the dropped
 * ones are exactly the things this answer will not be able to say — which is what `unknowns` is.
 * Deriving them separately would let the two disagree, and the disagreement would look like a model
 * omitting a section it was asked for.
 */
function plannedSections(
  identity: RepositoryIdentity,
  lead: AnswerLead,
  intent: QuestionIntent,
  focus: string | null,
): { readonly sections: readonly PlanSection[]; readonly unknowns: readonly string[] } {
  const template = INTENT_SECTIONS[intent] ?? LEAD_SECTIONS[lead];
  const subject = focus ?? 'the subject';
  const sections: PlanSection[] = [];
  const unknowns: string[] = [];
  /** Whether the section that was to establish what the thing is survived its evidence check. */
  let opened = false;

  for (const [index, section] of template.entries()) {
    const missing = section.requires.filter((field) => !carries(identity, field));

    if (missing.length === 0) {
      opened ||= index === 0;

      sections.push(
        // Only the subsystem template names a subject, and it is the one template whose sections cannot
        // be written without one. Substituting here keeps the tables literal.
        focus === null
          ? section
          : { ...section, title: section.title.replace(/\{subject\}/g, subject), purpose: section.purpose.replace(/\{subject\}/g, subject) },
      );

      continue;
    }

    unknowns.push(`${section.title} — ${missing.map((field) => UNKNOWN_REASON[field] ?? `no ${field} was detected`).join('; ')}`);
  }

  /*
   * A template that lost its opening gets one back, and a template that lost everything is one.
   *
   * **Both cases are reachable and both were seen on the validation battery.** Asked to explain
   * caching, four of thirteen repositories dropped the section that says what does the caching — they
   * have no cache — and kept the one about how it is configured, so the answer was planned to open
   * mid-explanation with the configuration of a thing it had not introduced. Two more dropped every
   * section. The opening section is the one a reader who stops after it still has an answer from, so a
   * plan without one is not a plan; the floor asks what the repository contains, which every
   * projection can support and no repository can fail to have.
   */
  const composed = opened ? sections : [FALLBACK_SECTION, ...sections];

  return { sections: composed.slice(0, SECTION_LIMIT), unknowns };
}

/**
 * How many sections one answer may have.
 *
 * Five, and the number is a token budget rather than an aesthetic. Question guidance measured 205 to
 * 457 tokens across the validation battery *before* sections existed, on prompts whose whole fact
 * budget is 5,500; a six-section list with its purposes is another eighty. Five is enough for a summary
 * plus four levels of descent, which is the deepest disclosure any of the templates below needs.
 */
const SECTION_LIMIT = 5;

const FALLBACK_SECTION: PlanSection = {
  title: 'what the repository contains',
  purpose: 'what was found, and what the analysis could not establish',
  requires: [],
  evidence: ['profile', 'packages', 'limitations'],
};

/**
 * Why an identity field being absent stops a section being written.
 *
 * **Phrased as a statement about the analysis, never about the repository.** "No cache was detected" is
 * true; "this repository does not cache" is a claim the graph cannot make, and it is the claim a reader
 * will take away if the distinction is left to them. The same rule `identity.ts` follows in choosing
 * `null` over `'none'`, carried into the sentence the model is actually shown.
 */
const UNKNOWN_REASON: Readonly<Record<string, string>> = {
  workflows: 'no route was linked to a handler, so no workflow could be traced',
  caching: 'no cache technology was detected',
  persistence: 'no persistence technology was detected',
  security: 'no access-control middleware and no secret-shaped configuration were found',
  deployment: 'no build or deployment files were detected',
  testing: 'no test framework was detected in the manifest',
  configuration: 'no environment variables are read',
  entryPoints: 'no routes were extracted and every unit is imported by another',
  extensionPoints: 'nothing in this repository looks like a plugin surface',
  integrations: 'no external package is referenced from the source',
  abstractions: 'nothing ranked highly enough to call a central abstraction',
  risks: 'the health analysis reported no findings',
  critical: 'no declaration could be ranked',
  units: 'no package could be derived',
  purpose: 'neither the repository type nor its domains could be established',
};

/**
 * The answer's shape, by what it leads with.
 *
 * **This is the "no fixed template" requirement, and its being nine tables rather than one parameterised
 * one is the point.** An orientation answer is not a shorter architecture answer with the sections
 * renamed; it is a route, and its second section is a place to start rather than a layer diagram. Side
 * by side, a reviewer can disagree with one line of one template.
 *
 * Every list opens with a section that stands alone in one paragraph, and descends from there. That is
 * the progressive disclosure: summary, then structure, then parts, then detail. A reader who stops at
 * the first section has an answer rather than an introduction.
 */
const LEAD_SECTIONS: Readonly<Record<AnswerLead, readonly PlanSection[]>> = {
  workflow: [
    {
      title: 'what the system is',
      purpose: 'one paragraph: what it does and who calls it',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'what happens when it does its job',
      purpose: 'trace the workflow from the outside in, in order',
      requires: ['workflows'],
      evidence: ['request-flow', 'routes'],
    },
    {
      title: 'what each part along that path is responsible for',
      purpose: 'the components the flow passes through, and what each owns',
      requires: ['critical'],
      evidence: ['architecture', 'packages'],
    },
    {
      title: 'where state lives',
      purpose: 'what is stored, what is cached, and what that buys',
      requires: ['persistence'],
      evidence: ['technologies', 'environmentVariables'],
    },
  ],
  components: [
    {
      title: 'what the repository is',
      purpose: 'one paragraph, before any part is named',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'how it is divided',
      purpose: 'the major units and what each is for',
      requires: ['units'],
      evidence: ['packages', 'regions'],
    },
    {
      title: 'which parts matter most, and why',
      purpose: 'the ranking, with the measurement behind each place',
      requires: ['critical'],
      evidence: ['purpose', 'hotspots'],
    },
    {
      title: 'how the units depend on one another',
      purpose: 'the relationships, not a second list',
      requires: ['components'],
      evidence: ['architecture', 'composition', 'cycles'],
    },
  ],
  orientation: [
    {
      title: 'what this repository is',
      purpose: 'one paragraph, so the path below has somewhere to lead',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'where to start',
      purpose: 'the first file or route to open, and why that one',
      requires: ['entryPoints'],
      evidence: ['architecture-summary', 'routes', 'packages'],
    },
    {
      title: 'what to read after that',
      purpose: 'the units that carry the most of the repository',
      requires: ['units'],
      evidence: ['packages', 'regions'],
    },
    {
      title: 'what to inspect once the shape is clear',
      purpose: 'the declarations everything else points at',
      requires: ['critical'],
      evidence: ['purpose', 'hotspots'],
    },
    {
      title: 'what to understand last',
      purpose: 'the thing that happens end to end, now that the parts have names',
      requires: ['workflows'],
      evidence: ['request-flow', 'routes'],
    },
  ],
  api: [
    {
      title: 'what the library does',
      purpose: 'one paragraph: what a caller gets from it',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'the public surface',
      purpose: 'what a consumer imports, and what each entry is for',
      requires: ['entryPoints'],
      evidence: ['packages', 'architecture-summary'],
    },
    {
      title: 'how the implementation is organised behind it',
      purpose: 'the units, and which of them a caller never sees',
      requires: ['units'],
      evidence: ['packages', 'regions'],
    },
    {
      title: 'what it rests on',
      purpose: 'the dependencies, and what each one buys',
      requires: ['integrations'],
      evidence: ['externalPackages', 'technologies'],
    },
  ],
  'extension-points': [
    {
      title: 'what the framework is for',
      purpose: 'one paragraph: what someone builds on it',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'where someone else’s code plugs in',
      purpose: 'the extension points, and what each one hooks into',
      requires: ['extensionPoints'],
      evidence: ['packages', 'externalPackages'],
    },
    {
      title: 'what sits behind those points',
      purpose: 'the internal units and what each is responsible for',
      requires: ['units'],
      evidence: ['packages', 'regions'],
    },
    {
      title: 'how the pieces fit together at runtime',
      purpose: 'the relationships between the units, not a list of them',
      requires: ['critical'],
      evidence: ['architecture', 'composition'],
    },
  ],
  pipeline: [
    {
      title: 'what it compiles, from what to what',
      purpose: 'one paragraph: the input and the output',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'the stages, in the order input moves through them',
      purpose: 'what each stage consumes and produces',
      requires: ['units'],
      evidence: ['packages', 'regions'],
    },
    {
      title: 'where the intermediate representations live',
      purpose: 'the declarations the stages hand between them',
      requires: ['critical'],
      evidence: ['purpose', 'hotspots'],
    },
  ],
  commands: [
    {
      title: 'what the tool does when it is run',
      purpose: 'one paragraph, from the shell inwards',
      requires: ['purpose'],
      evidence: ['purpose', 'profile'],
    },
    {
      title: 'the commands it offers',
      purpose: 'what each one does',
      requires: ['entryPoints'],
      evidence: ['architecture-summary', 'packages'],
    },
    {
      title: 'how a command reaches the work it performs',
      purpose: 'the path from invocation to the code that does it',
      requires: ['critical'],
      evidence: ['architecture', 'packages'],
    },
    {
      title: 'what it reads from its environment',
      purpose: 'the configuration a run depends on',
      requires: ['configuration'],
      evidence: ['environmentVariables'],
    },
  ],
  deployment: [
    {
      title: 'what is built and shipped',
      purpose: 'one paragraph: the artefacts and what produces them',
      requires: ['deployment'],
      evidence: ['technologies', 'composition'],
    },
    {
      title: 'what runs it',
      purpose: 'the runtime the artefacts are handed to',
      requires: ['deployment'],
      evidence: ['technologies', 'regions'],
    },
    {
      title: 'what a deployment must supply',
      purpose: 'the configuration, by what each value is for',
      requires: ['configuration'],
      evidence: ['environmentVariables'],
    },
  ],
  locate: [
    {
      title: 'the short answer: where to look',
      purpose: 'one paragraph naming the files or tests, before any explanation',
      // Nothing required, deliberately: a locating answer can always name a package or a route group, and
      // a repository with no test files at all still has somewhere to point. What it must not do is
      // invent a mapping, which is what the third section is for.
      requires: [],
      evidence: ['tests', 'packages', 'architecture'],
    },
    {
      title: 'what each one is and why it is the right place',
      purpose: 'one line per named thing, from what the graph records about it',
      requires: ['components'],
      evidence: ['architecture', 'hotspots', 'routes'],
    },
    {
      title: 'what the analysis cannot connect',
      purpose: 'say plainly where the mapping is a naming convention rather than a recorded relationship',
      requires: [],
      evidence: ['limitations'],
    },
  ],
  subsystem: [
    {
      title: 'what {subject} is for',
      purpose: 'one paragraph: its responsibility, and only its own',
      requires: ['components'],
      evidence: ['architecture', 'purpose'],
    },
    {
      title: 'what reaches {subject}, and what it reaches',
      purpose: 'the relationships either side of it',
      requires: ['components'],
      evidence: ['architecture', 'routes', 'incomingCalls'],
    },
    {
      title: 'where {subject} sits in the architecture',
      purpose: 'one sentence of placement, not a tour of the repository',
      requires: ['purpose'],
      evidence: ['architecture-summary', 'purpose'],
    },
  ],
};

/**
 * Shapes chosen by what the question is *about*, which override the lead's.
 *
 * **Only the five intents that name a responsibility appear**, and that restraint is the rule rather
 * than an omission. `architecture`, `packages` and `overview` are questions about the repository as a
 * whole, and the lead already knows the right shape for that — a framework's architecture answer and a
 * compiler's are genuinely different, and an intent table would flatten both into one. A question about
 * caching, by contrast, wants the same three things whatever kind of repository it is asked about.
 *
 * `technology` has no *tradeoffs* section, though the shape a reader expects has one. The graph records
 * that Redis is present and that a declaration is annotated `Cache`; it records nothing at all about
 * what choosing Redis cost, and a section asking for tradeoffs is a section a model can only fill from
 * outside the facts. It is the one place these tables decline to ask for what the reader wants.
 */
const INTENT_SECTIONS: Partial<Readonly<Record<QuestionIntent, readonly PlanSection[]>>> = {
  security: [
    {
      title: 'what surface is exposed',
      purpose: 'one paragraph: what can be reached from outside',
      requires: ['entryPoints'],
      evidence: ['routes', 'architecture-summary'],
    },
    {
      title: 'what guards it',
      purpose: 'the middleware and where in the chain it runs',
      requires: ['security'],
      evidence: ['routes', 'architecture'],
    },
    {
      title: 'where the secrets are configured',
      purpose: 'the configuration names, and what each protects',
      requires: ['configuration'],
      evidence: ['environmentVariables'],
    },
  ],
  caching: [
    {
      title: 'what does the caching',
      purpose: 'one paragraph: the technology and where it was detected',
      requires: ['caching'],
      evidence: ['technologies', 'externalPackages'],
    },
    {
      title: 'what it sits in front of',
      purpose: 'the read it makes fast, and the store behind it',
      requires: ['persistence'],
      evidence: ['technologies', 'request-flow'],
    },
    {
      title: 'how it is configured',
      purpose: 'the connection and any keys or lifetimes the facts name',
      requires: ['configuration'],
      evidence: ['environmentVariables'],
    },
  ],
  deployment: [
    {
      title: 'what is built and shipped',
      purpose: 'one paragraph: the artefacts and what produces them',
      requires: ['deployment'],
      evidence: ['technologies', 'composition'],
    },
    {
      title: 'what a deployment must supply',
      purpose: 'the configuration, by what each value is for',
      requires: ['configuration'],
      evidence: ['environmentVariables'],
    },
    {
      title: 'what is verified before it ships',
      purpose: 'the test tooling, where any was detected',
      requires: ['testing'],
      evidence: ['technologies'],
    },
  ],
  technology: [
    {
      title: 'what it is built with',
      purpose: 'one paragraph: the stack, in the words the facts use',
      requires: ['purpose'],
      evidence: ['technologies', 'profile'],
    },
    {
      title: 'what each one is responsible for here',
      purpose: 'the job each technology does in this repository',
      requires: ['integrations'],
      evidence: ['technologies', 'externalPackages'],
    },
    {
      title: 'how they meet',
      purpose: 'where the stack pieces touch each other',
      requires: ['persistence'],
      evidence: ['architecture', 'request-flow'],
    },
  ],
  hotspots: [
    {
      title: 'which parts matter most',
      purpose: 'one paragraph: the ranking and what produced it',
      requires: ['critical'],
      evidence: ['purpose', 'hotspots'],
    },
    {
      title: 'why each one ranks where it does',
      purpose: 'the measurement behind each place, not the place',
      requires: ['components'],
      evidence: ['hotspots', 'architecture'],
    },
    {
      title: 'what the analysis flagged',
      purpose: 'the findings, in the analyser’s own codes',
      requires: ['risks'],
      evidence: ['health', 'cycles'],
    },
  ],
};

/**
 * Whether the identity actually carries a field.
 *
 * The `Evidenced` fields are `null` when unproven, which is the whole convention `identity.ts` rests on
 * — so "carries it" is a null check for most of them and a length check for the ranked lists.
 */
function carries(identity: RepositoryIdentity, field: string): boolean {
  switch (field) {
    case 'profile':
      return true;
    case 'purpose':
      return identity.purpose !== null;
    case 'users':
      return identity.users !== null;
    case 'domains':
      return identity.domains.length > 0;
    case 'workflows':
      return identity.workflows.length > 0;
    case 'components':
      return identity.components.length > 0;
    case 'critical':
      return identity.critical.length > 0;
    case 'units':
      return identity.units.length > 0;
    default:
      return listValue(identity, field as keyof RepositoryIdentity).length > 0;
  }
}

/** One `Evidenced<readonly string[]>` field's value, or nothing where the field is absent or not one. */
function listValue(identity: RepositoryIdentity, field: keyof RepositoryIdentity): readonly string[] {
  const held = identity[field];

  if (held === null || held === undefined || !(typeof held === 'object') || !('value' in held)) {
    return [];
  }

  const { value } = held as { readonly value: unknown };

  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/**
 * The route into the repository, for a question that asked to be oriented.
 *
 * **Ordered by what a reader can understand at each point, not by importance.** The most-referenced
 * declaration in a repository is the worst possible first file: it is referenced by everything precisely
 * because it assumes everything. An entry point assumes nothing, which is what makes it an entry point,
 * and the ranking is what the third step is for.
 *
 * Empty for every other lead. A route is an answer to "where do I start", and offering one to a question
 * about caching is the same category error as answering an orientation question with an architecture
 * overview — the failure this planner was built to fix, running the other way.
 */
function navigationFor(identity: RepositoryIdentity, lead: AnswerLead): readonly NavigationStep[] {
  if (lead !== 'orientation') {
    return [];
  }

  /*
   * Built from `identity.onboarding` and from nothing else, which is the substance of §4.
   *
   * The previous version assembled the route from `entryPoints`, then `units`, then `critical`, then the
   * first workflow — and `critical` is the fan-in ranking. So on any repository where the first two were
   * absent, "start here" was the most-referenced declaration: the worst possible first file, since it is
   * referenced by everything precisely because it assumes everything. On an umbrella repository whose only
   * analysable code was four CI scripts, that produced `set_secret.py`.
   *
   * `identity.onboarding` admits only evidence about *approaching* a repository — documentation it ships, a
   * manifest entry point, a route, a declared package boundary, a traceable workflow — and no ranking is an
   * admissible kind. An empty list therefore stays empty, and the planner reports that rather than
   * substituting something measurable for something relevant. See `sufficiencyOf`.
   */
  const found = identity.onboarding.slice(0, 4).map((step) => ({ target: step.target, why: step.why }));

  /*
   * The stages are assigned by position, not by which evidence supplied the step.
   *
   * **A route whose first line reads "then read" is not a route.** client-go has no routes and no
   * traceable workflow, so its first candidate steps were absent and the answer was handed a path
   * beginning in the middle of itself. Whatever the strongest available evidence is, it is the first step.
   */
  const stages: NavigationStep['stage'][] = ['start here', 'then read', 'then inspect', 'finally'];

  return found.map((step, index) => ({ stage: stages[index] ?? 'finally', ...step }));
}

/**
 * Concepts this repository demonstrably has that this answer must leave alone.
 *
 * **Exclusions name concepts, and they never remove facts.** The projection is a reordering rather than
 * a filter, deliberately and everywhere, because a classifier that was wrong about the question would
 * otherwise cause a *missing repository* rather than a differently-ordered one — and this is a
 * classifier. So an exclusion is an instruction to the model, not a subtraction from the evidence: the
 * authentication facts are still there to be cited if the answer genuinely needs one, and the
 * instruction says not to spend the answer on them.
 *
 * **Only concepts the identity actually carries are named.** Telling a model not to discuss the
 * deployment of a repository that has none is a way of informing it that a deployment exists, which is
 * exactly the fabrication the whole layer exists to prevent.
 *
 * A repository-wide question with no responsibility intent excludes nothing. Its whole purpose is
 * breadth, and a breadth question that has been told to avoid four of its own subsystems is a question
 * that gets a worse answer than it asked for.
 */
const CONCEPTS: readonly (readonly [concept: string, field: keyof RepositoryIdentity])[] = [
  ['authentication and access control', 'security'],
  ['caching', 'caching'],
  ['persistence', 'persistence'],
  ['deployment', 'deployment'],
  ['testing', 'testing'],
  ['external integrations', 'integrations'],
  ['extension points', 'extensionPoints'],
];

/**
 * Question shapes narrow enough that leaving things out is an improvement rather than a loss.
 *
 * **Orientation and importance questions are deliberately absent, and both were removed after being
 * tried.** On LinkForge, "where should I start?" excluded authentication, caching, persistence,
 * deployment and testing — five of the things a newcomer's route through the repository would
 * legitimately pass through, forbidden because the orientation field list happens not to name them.
 * "What are the most important components?" did the same. Both are breadth questions wearing a specific
 * lead, and an exclusion list is only ever right for a question that has genuinely narrowed.
 */
function narrow(lead: AnswerLead, intent: QuestionIntent, focus: string | null): boolean {
  return (
    focus !== null ||
    lead === 'subsystem' ||
    lead === 'deployment' ||
    intent === 'security' ||
    intent === 'caching' ||
    intent === 'deployment'
  );
}

function exclusionsFor(
  identity: RepositoryIdentity,
  lead: AnswerLead,
  intent: QuestionIntent,
  fields: readonly string[],
  focus: string | null,
): readonly string[] {
  if (!narrow(lead, intent, focus)) {
    return [];
  }

  const excluded = CONCEPTS.filter(([, field]) => !fields.includes(field) && carries(identity, field)).map(
    ([concept]) => concept,
  );

  /*
   * The other domains, where the question named one.
   *
   * The strongest exclusion available, and the one the milestone's own example turns on: a question
   * about Redis on a repository organised around `url`, `analytics` and `auth` is a question about
   * caching in the `url` flow, and naming the two domains it is *not* about is what stops the answer
   * drifting into a tour. Only emitted for a focused question, because a repository-wide question is
   * about all of them.
   */
  const others =
    focus === null
      ? []
      : identity.domains
          .map((domain) => domain.name)
          .filter((name) => !name.includes(focus) && !focus.includes(name))
          .slice(0, 3);

  return [...new Set([...excluded, ...others])].slice(0, 5);
}

/**
 * The parts of a compound question.
 *
 * **Split on conjunctions, and only where both halves survive being read as questions on their own.**
 * "Explain authentication and how JWT works" is two requests; "explain the routes and layers" is one
 * request naming two things, and the difference is that the second half of the first is a clause with
 * its own verb. The test is crude — a fragment must carry three words — and it is allowed to be,
 * because being wrong costs one extra line of guidance rather than a differently-shaped answer.
 *
 * Merged, never answered separately: the tasks reach the prompt as a statement that the question has
 * two parts and both must be covered in one explanation. Generating twice and concatenating would
 * produce two answers with two openings, which is worse than the failure it fixes.
 */
function tasksIn(question: string, scopeInput: { readonly question: string; readonly kind: string; readonly subsystems: Iterable<string> }): readonly PlanTask[] {
  const words = question.trim().split(/\s+/).length;

  if (words < 8) {
    return [];
  }

  const fragments = question
    .split(/\s+(?:and|then|also|plus)\s+|[;?]/i)
    .map((fragment) => fragment.trim())
    // Two words, because "explain authentication" is a request and "layers." is a noun. The floor was
    // three and it discarded the first half of "Explain authentication and how JWT works" — the
    // canonical compound question, and the one case this exists for.
    .filter((fragment) => fragment.split(/\s+/).filter((word) => word !== '').length >= 2);

  if (fragments.length < 2) {
    return [];
  }

  const subsystems = [...scopeInput.subsystems];

  return fragments.slice(0, 3).map((fragment) => ({
    question: fragment,
    intent: intentOf(fragment),
    focus: focusOf({ question: fragment, kind: scopeInput.kind, subsystems }),
  }));
}

/**
 * How the fact budget divides between the four groups.
 *
 * **Shares by lead, because the lead is what decides the answer's proportions.** A workflow answer that
 * spent 45% of its facts on the component ranking would name a great many things and trace nothing; a
 * components answer that spent 40% on the request flow would trace one thing and rank nothing. The
 * numbers are the mission's own for the workflow case and derived from the same reasoning for the rest.
 *
 * Two adjustments, both of which prevent a share being spent on nothing:
 *
 * - **No workflows in the repository** and the workflow share goes to the components. There is nothing
 *   to narrate, and reserving 30% of the budget for facts that do not exist reserves it for whatever
 *   part happens to sort next.
 * - **A focused answer** shifts to the components, because a subsystem question is answered by the
 *   subsystem and its neighbours, and the architecture is one sentence of placement.
 */
const LEAD_ALLOCATION: Readonly<Record<AnswerLead, FactAllocation>> = {
  workflow: { architecture: 0.25, workflow: 0.4, components: 0.25, supporting: 0.1 },
  components: { architecture: 0.35, workflow: 0.1, components: 0.45, supporting: 0.1 },
  /*
   * A route is mostly units and declarations, and only its last step is a workflow.
   *
   * The workflow share was 0.2 and validation showed what that bought: on React, "where should I
   * start?" spent it on eight route facts and gave up eight package facts to pay for them — so the
   * answer to "what should I read after the entry point" lost the units it is made of, to buy detail
   * about a step the route reaches last. One share, sized to one step.
   */
  orientation: { architecture: 0.3, workflow: 0.1, components: 0.5, supporting: 0.1 },
  /*
   * A locating answer is almost entirely components and supporting evidence.
   *
   * The reader wants named files. `tests` is a supporting part, the packages and role layers are
   * components, and the architecture only has to earn the one sentence that says where the thing sits.
   */
  locate: { architecture: 0.1, workflow: 0.1, components: 0.45, supporting: 0.35 },
  subsystem: { architecture: 0.2, workflow: 0.25, components: 0.4, supporting: 0.15 },
  api: { architecture: 0.35, workflow: 0.1, components: 0.4, supporting: 0.15 },
  'extension-points': { architecture: 0.3, workflow: 0.1, components: 0.45, supporting: 0.15 },
  pipeline: { architecture: 0.35, workflow: 0.15, components: 0.4, supporting: 0.1 },
  commands: { architecture: 0.3, workflow: 0.2, components: 0.35, supporting: 0.15 },
  /*
   * Rebalanced when artefact analysis arrived, because the premise of the old shares had changed.
   *
   * They read `architecture: 0.15, supporting: 0.6`, with a comment saying a deployment answer is mostly
   * technologies and configuration — true while those were the only deployment evidence that existed. What
   * a compose file declares *is* the deployment: four services, and the repository's own statement that one
   * needs another. Those facts sit in the `architecture` group, so the old shares starved a deployment
   * question of the only part that could now answer it — measured at 4 artefact facts of 85 on a repository
   * whose deployment is entirely in YAML.
   */
  deployment: { architecture: 0.35, workflow: 0.1, components: 0.15, supporting: 0.4 },
};

function allocationFor(lead: AnswerLead, depth: ExplanationDepth, hasWorkflows: boolean): FactAllocation {
  const base = LEAD_ALLOCATION[lead];

  const shifted = hasWorkflows
    ? base
    : { ...base, workflow: 0, components: base.components + base.workflow };

  if (depth !== 'focused') {
    return shifted;
  }

  // A quarter of the architecture share moves to the components: placement is a sentence, and the rest
  // of a focused answer is the subject and what touches it.
  const moved = shifted.architecture * 0.25;

  return {
    ...shifted,
    architecture: round(shifted.architecture - moved),
    components: round(shifted.components + moved),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * How much the question already knows.
 *
 * Ordered, and the order is the precedence. A question that both says "I am new here" and names a
 * subsystem is a newcomer's question about a subsystem — the naming came from something they read, and
 * treating them as a specialist because of it is how an answer becomes unreadable to the person who
 * asked it.
 */
function audienceOf(
  question: string,
  scope: QuestionScope,
  focus: string | null,
  state: ConversationState,
): Audience {
  // A session that has established nothing says nothing about the reader, and the sentence decides
  // alone. Without this the empty state's `engineer` default would silently outrank every classification
  // below it on the very first turn.
  const level = state.turns === 0 ? null : state.level;

  if (NOVICE.test(question) || orienting(question)) {
    /*
     * The session outranks the sentence, and only ever upwards.
     *
     * "Where should I start?" is a newcomer's question the first time it is asked and something else
     * at turn twelve, when the reader has had six things explained to them — they are asking where to
     * go next, not what a controller is. A reader cannot become newer to a repository than they were,
     * so the session can raise this and never lower it, and a session that has established nothing
     * leaves it exactly where the sentence put it.
     */
    return level === null || level === 'newcomer' ? 'newcomer' : level;
  }

  if (CONTRIBUTION.test(question)) {
    return 'contributor';
  }

  // A resolved subject means the caller already navigated the repository to this declaration, and a
  // named subsystem means the question knew the repository had one. Either is more than a reader who
  // has only the repository's name.
  if (scope === 'entity' || focus !== null) {
    return 'specialist';
  }

  return level === 'specialist' ? 'specialist' : 'engineer';
}

/**
 * How sure the planner is of its reading.
 *
 * The three cases are the three ways a plan gets made: the caller resolved the subject or the question
 * named something the repository has (`certain`); the question matched one of the patterns above or
 * carried a responsibility intent (`likely`); nothing in it was distinctive and the plan is the
 * repository's own default shape (`uncertain`). The last is not a failure — most questions about a
 * repository are repository-wide questions, and the default shape is the right answer to them.
 */
function confidenceOf(
  question: string,
  scope: QuestionScope,
  focus: string | null,
  intent: QuestionIntent,
): PlanConfidence {
  if (scope === 'entity' || focus !== null) {
    return 'certain';
  }

  if (
    orienting(question) ||
    WORKFLOW_QUESTION.test(question) ||
    IMPORTANCE.test(question) ||
    LOCATION.test(question) ||
    (intent !== 'overview' && intent !== 'architecture')
  ) {
    return 'likely';
  }

  return 'uncertain';
}

/**
 * Whether the repository holds what this question asked about.
 *
 * **Only strongly typed questions are adjudicated.** "Explain the architecture" cannot be unanswerable —
 * every repository has a shape — so a sufficiency check on it would be noise. What can be unanswerable is
 * a question about a *named mechanism*: a cache, an authentication flow, a test suite, a deployment model.
 * Each of those has a detector, so each has an answer to "did we look, and could we have found it".
 *
 * The `undetermined` branch is the one that keeps this honest. A repository whose code was read only to
 * `universal` depth has no declarations at all, so finding no authentication middleware there is a fact
 * about the analyser. Claiming absence from it would be the same overreach in the opposite direction from
 * the one this milestone set out to fix.
 */
function sufficiencyOf(
  identity: RepositoryIdentity,
  intent: QuestionIntent,
  lead: AnswerLead,
  question: string,
  components: readonly ComponentImportance[],
): EvidenceSufficiency {
  const established = (concept: string, detail: string): EvidenceSufficiency => ({
    verdict: 'established',
    concept,
    detail,
  });

  /*
   * Whether the analysis could have found code-level evidence at all.
   *
   * A region read to `universal` depth was listed rather than parsed, so no declaration, call or
   * annotation exists to have found. Where that is true of the whole repository, an absence of anything
   * declaration-shaped is a statement about the reading rather than about the repository.
   */
  const shallow =
    identity.profile.depth === 'universal' ||
    identity.profile.scale.declarations === 0 ||
    /*
     * None of the repository's *own* code was analysed, whatever else was.
     *
     * An umbrella of git submodules has its contents in other repositories by construction, and a
     * repository whose only analysable declarations are CI scripts has had its architecture read by
     * nobody. Twelve semantically analysed declarations is not "we looked": it is "we looked at the
     * build". Claiming absence from that would be the same overreach this milestone set out to fix,
     * arriving from the other direction.
     */
    identity.category === 'umbrella' ||
    (identity.critical.length === 0 && identity.units.length === 0);

  const missing = (concept: string, looked: string): EvidenceSufficiency =>
    shallow
      ? {
          verdict: 'undetermined',
          concept,
          detail: `${looked}, and no region of this repository was analysed deeply enough to carry declarations — so this is a limit of the analysis rather than a finding about the repository`,
        }
      : { verdict: 'absent', concept, detail: looked };

  switch (intent) {
    case 'caching':
      return identity.caching === null
        ? missing(
            'a caching mechanism',
            'no cache technology was detected in the manifests or the source, and no configuration names one',
          )
        : established('a caching mechanism', `${identity.caching.value.join(', ')} — ${identity.caching.evidence.join('; ')}`);

    case 'security':
      /*
       * Secret management is not an authentication flow, and this branch is why the milestone exists.
       *
       * A repository can hold `set_secret.py` and a `JWT_SECRET` variable and have no authentication
       * anywhere. `identity.security` already refuses to report secrets alone as a guard — see
       * `securityOf` — so a null here with configuration present is the exact case that produced an
       * invented authentication architecture, and it is reported as such rather than as plain absence.
       */
      if (identity.security !== null) {
        return established('an authentication or access-control mechanism', identity.security.evidence.join('; '));
      }

      return {
        ...missing(
          'an authentication or access-control mechanism',
          'no middleware named for access control was found, and the repository exposes no route of its own for one to guard',
        ),
        ...(identity.configuration === null
          ? {}
          : {
              detail:
                'no middleware named for access control was found and the repository exposes no route of its own for one to guard; the repository does read secret-shaped configuration, which is credential storage rather than an authentication flow',
            }),
      };

    case 'deployment':
      return identity.deployment === null
        ? missing('a deployment model', 'no build, container or deployment file was detected')
        : established('a deployment model', identity.deployment.value.join(', '));

    default:
      break;
  }

  /*
   * An onboarding question with no onboarding evidence.
   *
   * **The branch §4 asks for, and it has to be a sufficiency verdict rather than a prompt line.** "Where
   * should I start?" was previously always answerable, because the route was assembled from whatever ranked
   * highest — so a repository that had told nobody where to start still received a confident three-step
   * path into its CI scripts. What makes a starting point defensible is documentation the repository ships,
   * an entry point a manifest declares, a route it serves, or a boundary it packages; `identity.onboarding`
   * admits exactly those and no ranking, so an empty list means the repository has not said.
   *
   * `undetermined` rather than `absent` wherever the analysis could not have seen it — `shallow` above —
   * because "this repository does not say where to start" and "we could not read enough of it to tell" are
   * different claims and only the first would be ours to make.
   */
  if (lead === 'orientation') {
    if (identity.onboarding.length > 0) {
      const kinds = [...new Set(identity.onboarding.map((step) => step.kind))];

      return established(
        'a way into the repository',
        `${identity.onboarding.length} starting ${identity.onboarding.length === 1 ? 'point' : 'points'} established from ${kinds.join(', ')} evidence`,
      );
    }

    return missing(
      'a way into the repository',
      'no documentation, manifest entry point, route or separately packaged unit was found to start a reader from — and a ranking is not a starting point',
    );
  }

  if (lead === 'locate' && ABOUT_TESTS.test(question)) {
    return identity.tests === null
      ? missing('tests', 'no declaration in the repository’s own code carries the Test role')
      : established('tests', identity.tests.evidence.join('; '));
  }

  /*
   * A question that asked for a particular kind of code and got none of it.
   *
   * Reached where `componentsFor` returned nothing because the requested role has no components — which is
   * deliberate, and which would otherwise leave the answer to be built from whatever else fitted.
   */
  if (components.length === 0 && (INTENT_ROLES[intent] !== undefined || (lead === 'locate' && rolesForLocating(question) !== null))) {
    return missing(
      'code of the kind this question asked about',
      'no declaration in the repository carries a role matching the question',
    );
  }

  return established('the subject of the question', 'the repository carries evidence of the kind asked for');
}
