import { describe, expect, it } from 'vitest';

import { EVIDENCE_POLICY, INTENTS, focusOf, intentOf, scopeOf } from './intent.js';
import { deriveIdentity } from './identity.js';
import { planFor } from './plan.js';
import { project } from './projection.js';
import { deriveProfile, subsystemsOf } from './profile.js';
import { questionGuidance } from './strategy.js';
import { repositoryContext, wideRepositoryContext } from './fixtures.test-helper.js';
import type { RepositoryContext } from '@traceiq/context';
import type { ContextProjection } from './facts.js';

/**
 * Intent-aware retrieval, and the failures it was built from.
 *
 * **Every case here is a real answer that was wrong, reduced to the property that made it wrong.** They
 * fall into three families, and the three are independent — fixing one left the other two intact, which is
 * why they are tested apart:
 *
 * 1. **A broad question narrowed to a locally prominent name.** "Explain the architecture" resolved a
 *    focus of `explain`, because TraceIQ ships `packages/explain` and the word that classified the
 *    question was also a directory in it. The whole repository-level question was planned as a question
 *    about one part.
 * 2. **An evidence family priced out of its own question.** `key-artifacts: 0 of 43` on an architecture
 *    question, `hotspots: 10 of 120` in the same projection — both parts sit in the same budget group, so
 *    whichever ran first spent the share and the other got nothing.
 * 3. **A ranking answering a question a ranking cannot answer.** An onboarding route built from fan-in
 *    recommends the most-referenced declaration, which is the worst possible first file in any repository.
 *
 * The fixtures are shapes rather than repositories, and nothing under test may key on a name in one.
 */

/** A repository that ships a package whose last segment is also the verb the question opens with. */
function withPackages(names: readonly string[]): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Record<string, unknown>;
  const entries = names.map((name, index) => ({
    name,
    files: 20 - index,
    declarations: 200 - index * 10,
    dependencies: 2,
    dependents: 3,
  }));

  return {
    ...base,
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: { ...overview, packages: { entries, total: entries.length, truncated: false } },
      },
    },
  } as unknown as RepositoryContext;
}

const kept = (projection: ContextProjection, part: string): number =>
  projection.omissions.find((omission) => omission.part === part)?.kept ??
  // A part with no omission contributed everything it had; count its facts rather than assuming zero.
  projection.facts.length;

const predicates = (projection: ContextProjection): ReadonlySet<string> =>
  new Set(projection.facts.map((fact) => fact.predicate));

const planFrom = (context: RepositoryContext, question: string) =>
  planFor({ identity: deriveIdentity(context), question, kind: 'repository' });

// ---------------------------------------------------------------------------------------------
// A broad question stays broad
// ---------------------------------------------------------------------------------------------

describe('a repository-wide question is not narrowed to the word that classified it', () => {
  it('does not become a question about a package named after the verb it opens with', () => {
    /*
     * The observed failure, exactly. `packages/explain` contributes `explain` to the subsystem set, the
     * question opens with `Explain`, and the whole broadest question there is was scoped to one aspect,
     * planned as a subsystem, and given 70% of its evidence budget to components.
     */
    const context = withPackages(['packages/explain', 'packages/core', 'packages/api']);
    const subsystems = subsystemsOf(deriveProfile(context));

    expect(subsystems.has('explain')).toBe(true);
    expect(focusOf({ question: 'Explain the architecture', kind: 'repository', subsystems })).toBeNull();
    expect(scopeOf({ question: 'Explain the architecture', kind: 'repository', subsystems })).toBe('whole');
    expect(planFrom(context, 'Explain the architecture').lead).toBe('architecture');
  });

  it('still narrows where the same word is used as a noun rather than as the asking verb', () => {
    /*
     * The guard is about the job a word does in the sentence, not about the word. "How does the explain
     * package work" names a thing; the determiner in front of it is what says so, and a guard that made a
     * genuinely named subsystem unaskable would have traded one failure for another.
     */
    const context = withPackages(['packages/explain', 'packages/core']);
    const subsystems = subsystemsOf(deriveProfile(context));

    expect(focusOf({ question: 'How does the explain package work?', kind: 'repository', subsystems })).toBe('explain');
  });

  it('does not narrow a capability question to a directory named after the capability', () => {
    // `deployment`, `caching` and `pipeline` are all ordinary directory names and all classify a question.
    const context = withPackages(['packages/deployment', 'packages/pipeline', 'packages/core']);
    const subsystems = subsystemsOf(deriveProfile(context));

    expect(focusOf({ question: 'How does deployment work?', kind: 'repository', subsystems })).toBeNull();
    expect(planFrom(context, 'How does deployment work?').lead).toBe('deployment');
  });

  it('still narrows to a technology the repository contains, whichever intent its name selects', () => {
    // `redis` selects the caching intent and is also a thing a repository has. The distinction between a
    // word that names a kind of question and one that names a thing is declared on the policy.
    const context = repositoryContext();
    const subsystems = new Set([...subsystemsOf(deriveProfile(context)), 'redis']);

    expect(focusOf({ question: 'Explain Redis.', kind: 'repository', subsystems })).toBe('redis');
  });

  it.each([
    ['as a developer from where should i start to understand best of this repo', 'orientation'],
    ['Where should a new developer begin?', 'orientation'],
    ['what should i read first', 'orientation'],
    ['How do I get up to speed on this codebase?', 'orientation'],
    ['Walk me through one important workflow.', 'workflow'],
    ['What are the major components?', 'components'],
    ['How is this repository structured?', 'architecture'],
    ['Explain the architecture', 'architecture'],
  ])('reads %j as %s, imperfect grammar and all', (question, lead) => {
    // Natural variants, including the ungrammatical one a real user typed. A classifier that only works on
    // well-formed questions is a classifier that works in tests.
    expect(planFrom(repositoryContext(), question).lead).toBe(lead);
  });
});

// ---------------------------------------------------------------------------------------------
// Every intent's policy is well formed
// ---------------------------------------------------------------------------------------------

describe('the evidence policy', () => {
  it('names a policy for every intent, with no family both leading and merely supporting', () => {
    for (const intent of INTENTS) {
      const policy = EVIDENCE_POLICY[intent];
      const overlap = policy.priority.filter((part) => policy.supporting.includes(part));

      expect(overlap, `${intent} both leads with and demotes ${overlap.join(', ')}`).toEqual([]);
    }
  });

  it('demotes the ranking on every intent except the one that asks for a ranking', () => {
    for (const intent of INTENTS) {
      if (intent === 'hotspots') {
        // A reader asking which declarations are most referenced has asked for the measurement.
        expect(EVIDENCE_POLICY.hotspots.priority).toContain('hotspots');
        continue;
      }

      expect(EVIDENCE_POLICY[intent].priority, `${intent} leads with a ranking`).not.toContain('hotspots');
      expect(EVIDENCE_POLICY[intent].supporting, `${intent} does not cap the ranking`).toContain('hotspots');
    }
  });

  it('never uses a named technology as a word a question cannot be about', () => {
    // `redis` and `docker` classify a question *and* name things a repository contains. Only the abstract
    // capability nouns may be treated as pure question vocabulary.
    for (const intent of INTENTS) {
      const policy = EVIDENCE_POLICY[intent];

      for (const named of policy.named ?? []) {
        expect(policy.concepts, `${intent} treats ${named} as question vocabulary`).not.toContain(named);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Composition changes with the question, and no family monopolises
// ---------------------------------------------------------------------------------------------

describe('what a question is answered from', () => {
  /** A repository large enough that the budget binds, which is the only case worth measuring. */
  const wide = wideRepositoryContext(80);

  const projectionFor = (question: string): ContextProjection => {
    const plan = planFrom(wide, question);

    return project(wide, {
      tier: 'standard',
      intent: intentOf(question),
      parts: plan.parts,
      allocation: plan.allocation,
      reserved: 1_800,
      coreReserved: 1_400,
    });
  };

  it('seats every family the intent is answered from, rather than the first one to run', () => {
    /*
     * **The measured failure, as a property.** `key-artifacts: 0 of 43` and `hotspots: 10 of 120` came from
     * one projection: both parts sit in the same budget group, the group's share was spent by whichever
     * extractor sorted first, and the family that could actually answer the question got nothing. The
     * floor gives each family a bounded amount before any family gets a second helping.
     */
    const projection = projectionFor('Explain the architecture');
    const missing = EVIDENCE_POLICY.architecture.priority.filter((part) => {
      const omission = projection.omissions.find((entry) => entry.part === part);

      // A family with nothing to offer is absent from the tally entirely, which is not a starvation.
      return omission !== undefined && omission.kept === 0 && omission.total > 0;
    });

    expect(missing, `starved: ${missing.join(', ')}`).toEqual([]);
  });

  it('caps the ranking so it can support a broad answer and never constitute one', () => {
    const architecture = projectionFor('Explain the architecture');
    const ranking = projectionFor('Which declarations are most referenced?');

    expect(kept(architecture, 'hotspots')).toBeLessThanOrEqual(3);
    // The one question a ranking answers is not capped, or the demotion would have become a prohibition.
    expect(kept(ranking, 'hotspots')).toBeGreaterThan(3);
  });

  it('changes what it retrieves with the question, which is the whole reason an intent exists', () => {
    const architecture = predicates(projectionFor('Explain the architecture'));
    const deployment = predicates(projectionFor('How does deployment work?'));
    const onboarding = predicates(projectionFor('Where should I start?'));

    expect(onboarding.has('onboarding')).toBe(true);
    expect(deployment.has('built-with') || deployment.has('declares')).toBe(true);
    // Three questions, three different fact compositions. Two that agreed would mean the intent decided
    // nothing, which is the state this whole mechanism exists to leave.
    expect([...architecture].join(',')).not.toBe([...deployment].join(','));
    expect([...deployment].join(',')).not.toBe([...onboarding].join(','));
  });

  it('brings a recovery request forward without enlarging the prompt', () => {
    /*
     * A recovery projection is built at the same tier against the same reservation, so it buys a different
     * composition rather than a bigger one — which is what keeps one bounded retry from being a way around
     * the budget.
     */
    const plan = planFrom(wide, 'Explain the architecture');
    const options = {
      tier: 'standard' as const,
      intent: 'architecture' as const,
      parts: plan.parts,
      allocation: plan.allocation,
      reserved: 1_800,
      coreReserved: 1_400,
    };

    const before = project(wide, options);
    const after = project(wide, { ...options, recovery: ['hotspots', 'cycles'] });

    expect(after.digest).not.toBe(before.digest);
    expect(after.tokens).toBeLessThanOrEqual(before.tokens + 40);
    // The requested family is deepened past the supporting cap that would otherwise hold it to three.
    expect(kept(after, 'hotspots')).toBeGreaterThan(kept(before, 'hotspots'));
  });
});

// ---------------------------------------------------------------------------------------------
// Prominence is not importance
// ---------------------------------------------------------------------------------------------

describe('prominence is not importance', () => {
  it('does not offer a ranking as a reading order', () => {
    /*
     * `identity.onboarding` admits documentation, manifest entry points, package boundaries and routes,
     * and admits no ranking — but the orientation *template* asked for "the declarations everything else
     * points at" under a heading telling a reader to go and inspect them, which put the ranking back in
     * through the section list. The most-referenced declaration is the worst possible third file: it is
     * referenced by everything precisely because it assumes everything.
     */
    const plan = planFrom(repositoryContext(), 'Where should I start?');

    expect(plan.parts).toContain('onboarding');
    expect(plan.parts).not.toContain('hotspots');

    for (const section of plan.sections) {
      expect(section.evidence, `${section.title} rests on a ranking`).not.toContain('hotspots');
    }
  });

  it('offers the ranked list as something to name, not as something to emphasise', () => {
    /*
     * The instruction read "Spend the most space on these, in this order. The stars are how much of the
     * repository points at each" — which is a fan-in measurement presented as an editorial priority, and
     * therefore the `prominence-as-importance` claim written as an order to the model. It was following
     * instructions when it wrote the sentence the entailment guard then rejected.
     */
    const plan = planFrom(repositoryContext(), 'What are the most important parts?');
    const guidance = questionGuidance(plan.strategy, plan);

    expect(guidance).not.toContain('Spend the most space');
    expect(guidance).toContain('a measurement of how much of the repository points at each');
  });

  it('leads a repository-level answer with the units rather than with the ranking', () => {
    /*
     * A repository is divided into its units; what those units point at is evidence behind that. Leading
     * with `identity.critical` — the fan-in ranking — hands a model a list of highly-referenced
     * declarations under the heading "what this repository is divided into", which is the substitution
     * this whole section is about.
     */
    const context = withPackages(['packages/core', 'packages/api', 'packages/util']);
    const identity = deriveIdentity(context);
    const plan = planFrom(context, 'Explain the architecture');

    expect(identity.units.length).toBeGreaterThan(0);
    expect(plan.components.length).toBeGreaterThan(0);
    expect(identity.units.map((unit) => unit.name)).toContain(plan.components[0]?.name);
    // And the ranked declarations are still there, behind them, where evidence belongs.
    expect(plan.components.map((component) => component.name)).toContain(identity.critical[0]?.name);
  });
});
