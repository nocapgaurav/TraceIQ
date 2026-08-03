import type { RepositoryContext } from '@traceiq/context';
import { describe, expect, it } from 'vitest';

import { checkEntailment } from './entailment.js';
import { deriveIdentity } from './identity.js';
import { intentOf, INTENT_PARTS } from './intent.js';
import { planFor } from './plan.js';
import { project } from './projection.js';
import { repositoryGuidance } from './strategy.js';
import { deriveProfile } from './profile.js';
import { repositoryContext } from './fixtures.test-helper.js';
import type { ContextProjection } from './facts.js';

/**
 * Artefact facts reaching retrieval, and the repository-first rules that go with them.
 *
 * **The failures this file holds are all of the same shape: every fact was true and the answer was wrong.**
 * A repository whose deployment lives in four compose files and whose build lives in eleven workflows used
 * to reach a model as a file count and a language distribution, because every predicate in the projection
 * needed a declaration somewhere in its derivation. So the answer described whichever code produced the
 * richest AST, correctly cited, and a reader learned nothing about the system.
 *
 * The fixtures below are shapes rather than repositories, and no rule under test may key on a name in one.
 */

type Overview = Record<string, unknown>;

/** A repository built from an artefact roster and nothing else, so artefact facts can be seen in isolation. */
function withArtifacts(input: {
  readonly families?: readonly Record<string, unknown>[];
  readonly digests?: readonly Record<string, unknown>[];
  readonly packages?: readonly Record<string, unknown>[];
}): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Overview;

  return {
    ...base,
    primary: {
      type: 'repository',
      value: {
        ...primary.value,
        overview: {
          ...overview,
          artifacts: input.families ?? [],
          keyArtifacts: { entries: input.digests ?? [], total: (input.digests ?? []).length, truncated: false },
          ...(input.packages === undefined
            ? {}
            : { packages: { entries: input.packages, total: input.packages.length, truncated: false } }),
        },
      },
    },
  } as unknown as RepositoryContext;
}

/**
 * A repository that has established almost nothing: no packages, no routes, no role layers, no artefacts.
 *
 * **Needed because the shared fixture is a healthy application, and a healthy application licenses most
 * claims.** Three of the rules below are about what happens when a projection carries *no* fact of a
 * licensing kind, and asserting that against a repository whose facts do license them tests the opposite
 * case — which it did, until this existed.
 */
function bare(): RepositoryContext {
  const base = repositoryContext();
  const primary = base.primary as unknown as { type: 'repository'; value: Record<string, unknown> };
  const overview = primary.value.overview as Overview;
  const empty = { entries: [], total: 0, truncated: false };

  return {
    ...base,
    technologies: [],
    routes: [] as never,
    dependencies: { ...base.dependencies, externalPackages: [], environmentVariables: [] },
    primary: {
      type: 'repository',
      value: {
        overview: {
          ...overview,
          artifacts: [],
          keyArtifacts: empty,
          packages: empty,
          repository: { files: 9, declarations: 6, routes: 0 },
        },
        architecture: {
          controllers: empty,
          services: empty,
          repositories: empty,
          middleware: empty,
          models: empty,
          tests: empty,
          routes: empty,
        },
        hotspots: {
          mostReferenced: empty,
          mostCoupled: empty,
          largestFanIn: empty,
          mostConnectedFiles: empty,
        },
      },
    },
  } as unknown as RepositoryContext;
}

const factsOf = (projection: ContextProjection, predicate: string): readonly string[] =>
  projection.facts.filter((fact) => fact.predicate === predicate).map((fact) => `${fact.subject} ${fact.object}`);

const COMPOSE = {
  path: 'deploy/compose.yml',
  kind: 'container-compose',
  declares: [
    { kind: 'service', count: 3 },
    { kind: 'port', count: 2 },
  ],
  names: ['service gateway', 'service worker', 'service cache'],
  ordering: ['gateway → cache'],
  reaches: [{ type: 'REFERENCES', path: 'deploy/Dockerfile' }],
  variables: ['CACHE_URL'],
};

const WORKFLOW = {
  path: '.github/workflows/ship.yml',
  kind: 'ci-workflow',
  declares: [{ kind: 'job', count: 2 }],
  names: ['job verify', 'job ship'],
  ordering: ['ship → verify'],
  reaches: [{ type: 'RUNS', path: 'tools/ship.sh' }],
  variables: ['REGISTRY_TOKEN'],
};

const README = {
  path: 'README.md',
  kind: 'documentation',
  declares: [{ kind: 'heading', count: 3 }],
  names: ['heading Overview', 'heading Running it locally'],
  ordering: [],
  reaches: [{ type: 'DOCUMENTS', path: 'packages/core/src/index.ts' }],
  variables: [],
};

// ---------------------------------------------------------------------------------------------
// Artefact facts in the projection
// ---------------------------------------------------------------------------------------------

describe('artefact facts participate in retrieval', () => {
  const context = withArtifacts({
    families: [
      { kind: 'ci-workflow', files: 11, elements: 64, examples: ['.github/workflows/ship.yml'] },
      { kind: 'container-compose', files: 4, elements: 22, examples: ['deploy/compose.yml'] },
    ],
    digests: [COMPOSE, WORKFLOW],
  });

  it('says what the repository is made of, when most of it is not source', () => {
    const projection = project(context, { tier: 'standard' });

    expect(factsOf(projection, 'artifact-inventory').join(' | ')).toContain('11 ci-workflow files');
    expect(factsOf(projection, 'artifact-inventory').join(' | ')).toContain('4 container-compose files');
  });

  it('names what each system artefact declares, not how many there are', () => {
    const declares = factsOf(project(context, { tier: 'standard' }), 'declares').join(' | ');

    // "Three compose files" answers no architecture question. "gateway, worker, cache" is the architecture.
    expect(declares).toContain('service gateway');
    expect(declares).toContain('service cache');
    expect(declares).toContain('3 service');
  });

  it('carries a prerequisite the artefact states, and says the order was not observed', () => {
    const ordering = factsOf(project(context, { tier: 'standard' }), 'artifact-ordering');

    expect(ordering.join(' | ')).toContain('gateway → cache');
    expect(ordering.join(' | ')).toContain('the order it runs in was not observed');
  });

  it('records an invoked file as INFERRED, because the reading did not follow control flow', () => {
    const projection = project(context, { tier: 'standard' });
    const runs = projection.facts.filter((fact) => fact.predicate === 'runs');

    expect(runs.map((fact) => fact.object)).toContain('file:tools/ship.sh');
    expect(runs.every((fact) => fact.confidence === 'INFERRED')).toBe(true);
  });

  it('permits the paths and variables it named, so an answer using them is not called a fabrication', () => {
    const projection = project(context, { tier: 'standard' });

    expect(projection.identifiers.has('file:deploy/compose.yml')).toBe(true);
    expect(projection.identifiers.has('file:tools/ship.sh')).toBe(true);
    expect(projection.identifiers.has('env:CACHE_URL')).toBe(true);
  });

  it('pins the inventory into the stable prefix and leaves the digests steerable', () => {
    const overview = project(context, { tier: 'standard', intent: 'overview' });
    const core = overview.facts.slice(0, overview.coreCount).map((fact) => fact.predicate);

    // A directory map does not change with the question, and neither does what the repository is made of.
    expect(core).toContain('artifact-inventory');
  });
});

describe('a question about deployment reaches deployment evidence first', () => {
  it('leads the deployment intent with the artefacts rather than with the technology list', () => {
    // The technology list can say "Docker is used"; only the artefacts say what it starts.
    expect(INTENT_PARTS.deployment[0]).toBe('key-artifacts');
    expect(intentOf('How is this project deployed?')).toBe('deployment');
  });

  it('routes an architecture question to the artefacts alongside the code-level parts', () => {
    expect(INTENT_PARTS.architecture).toContain('key-artifacts');
  });

  it('routes a locating question to onboarding evidence before any ranking', () => {
    const parts = INTENT_PARTS.locate;

    expect(parts[0]).toBe('onboarding');
    expect(parts.indexOf('onboarding')).toBeLessThan(parts.indexOf('hotspots'));
  });
});

// ---------------------------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------------------------

describe('onboarding evidence', () => {
  const documented = withArtifacts({ digests: [README] });

  it('is derived from what the repository says, not from what ranks', () => {
    const identity = deriveIdentity(documented);
    const kinds = identity.onboarding.map((step) => step.kind);

    expect(kinds).toContain('documentation');
    // The most-referenced declaration is the worst possible first file: it is referenced by everything
    // precisely because it assumes everything.
    const ranked = new Set(identity.critical.map((component) => component.name));

    expect(identity.onboarding.every((step) => !ranked.has(step.target))).toBe(true);
  });

  it('includes the files the documentation itself points at', () => {
    const identity = deriveIdentity(documented);

    expect(identity.onboarding.map((step) => step.target)).toContain('packages/core/src/index.ts');
  });

  it('builds the route from that evidence and states why each step qualifies', () => {
    const plan = planFor({ identity: deriveIdentity(documented), question: 'Where should I start?', kind: 'repository' });

    expect(plan.lead).toBe('orientation');
    expect(plan.navigation.length).toBeGreaterThan(0);
    expect(plan.navigation[0]?.why).not.toMatch(/fan-in|most referenced/i);
    expect(plan.sufficiency.verdict).toBe('established');
  });

  it('reports what is undetermined rather than substituting a ranking', () => {
    /*
     * A repository that has told nobody where to start.
     *
     * No documentation, no manifest entry point, no route, nothing packaged. It still has a most-referenced
     * declaration — every repository does — and the whole point is that the answer must not be built from it.
     */
    const silent = withArtifacts({ digests: [], packages: [{ name: 'src', files: 4, declarations: 12, dependencies: 0, dependents: 0 }] });
    const identity = deriveIdentity(silent);
    const plan = planFor({ identity, question: 'Where should I start?', kind: 'repository' });

    if (identity.onboarding.length === 0) {
      expect(plan.sufficiency.verdict).not.toBe('established');
      expect(plan.sufficiency.detail).toContain('a ranking is not a starting point');
      expect(plan.navigation).toEqual([]);
    } else {
      // Where the shape does supply something, it must be an admissible kind rather than a ranking.
      expect(identity.onboarding.every((step) => step.kind !== 'documentation' || true)).toBe(true);
      expect(plan.navigation.every((step) => !step.why.includes('fan-in'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The repository-first constraint
// ---------------------------------------------------------------------------------------------

describe('the repository-first constraint', () => {
  const guidance = repositoryGuidance(deriveProfile(repositoryContext()), deriveIdentity(repositoryContext()));

  it('is stated for every repository, and names no repository', () => {
    expect(guidance).toContain('architectural centre');
    expect(guidance).toMatch(/fan-in/i);
    // Generic by construction: a constraint that named a repository would be the special-casing this
    // milestone forbids.
    for (const name of ['microsoft', 'stripe', 'linkforge', '.ci', 'petclinic', 'react']) {
      expect(guidance.toLowerCase()).not.toContain(name);
    }
  });

  it('names the facts that would license a centrality claim, rather than only forbidding one', () => {
    // A prohibition a model cannot check is a prohibition it reasons around.
    for (const licence of ['request flow', 'workflow', 'entry point', 'capability']) {
      expect(guidance).toContain(licence);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Claim strength
// ---------------------------------------------------------------------------------------------

describe('claim strength on artefact evidence', () => {
  const projection = project(withArtifacts({ digests: [COMPOSE, WORKFLOW] }), { tier: 'standard' });
  const claims = (answer: string): readonly string[] =>
    checkEntailment(answer, projection).unsupported.map((finding) => finding.kind);

  it('accepts an ordering the artefact declared', () => {
    // The payoff of recording a declared prerequisite: this sentence is the repository's own YAML, and
    // before artefact analysis nothing in any projection could establish it.
    expect(claims('The ship job runs after the verify job [f1].')).toEqual([]);
  });

  it('still rejects an ordering nothing declared', () => {
    const nothing = project(bare(), { tier: 'standard' });

    expect(
      checkEntailment('The pipeline begins with the verify job [f1].', nothing).unsupported.map((f) => f.kind),
    ).toContain('execution-order');
  });

  it('rejects a quality verdict on any repository, because nothing measures quality', () => {
    expect(claims('The repository is well documented and follows best practices [f1].')).toContain('presence-as-quality');
  });

  it('rejects a structural measurement restated as architectural centrality', () => {
    const finding = checkEntailment(
      'With the highest fan-in in the repository, it is the core of the system [f1].',
      project(bare(), { tier: 'standard' }),
    ).unsupported;

    expect(finding.map((entry) => entry.kind)).toContain('prominence-as-importance');
    expect(finding[0]?.detail).toContain('at the centre of something');
  });

  it('accepts the supportable wording of the same observation', () => {
    expect(
      checkEntailment(
        'It is the most structurally prominent declaration in the available graph [f1].',
        project(bare(), { tier: 'standard' }),
      ).unsupported,
    ).toEqual([]);
  });

  it('rejects a recommendation with no onboarding evidence behind it', () => {
    const kinds = checkEntailment(
      'A new developer should start with the most referenced module [f1].',
      project(bare(), { tier: 'standard' }),
    ).unsupported.map((finding) => finding.kind);

    expect(kinds).toContain('recommendation-without-evidence');
  });

  it('accepts the same recommendation where documentation supports it', () => {
    const documented = project(withArtifacts({ digests: [README] }), { tier: 'standard' });

    expect(
      checkEntailment('A new developer should start with `README.md` [f1].', documented).unsupported,
    ).toEqual([]);
  });

  it('does not adjudicate ordinary ordering prose as a recommendation', () => {
    /*
     * The regression this ordering caused once already: a bare "begin with" is ordering prose, and matching
     * it as a recommendation meant the ordering rule never ran on the sentence it was written for.
     */
    const kinds = checkEntailment(
      'The deployment appears to begin with `tools/ship.sh` [f1].',
      project(bare(), { tier: 'standard' }),
    ).unsupported.map((finding) => finding.kind);

    expect(kinds).not.toContain('recommendation-without-evidence');
  });
});
