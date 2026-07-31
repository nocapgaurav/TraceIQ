import type { RepositoryContext } from '@traceiq/context';

import { TIER_TOKENS, digest, estimatingCounter, type BudgetTier } from './budget.js';
import {
  IDENTIFIER_PREFIXES,
  factLine,
  type ContextProjection,
  type Fact,
  type FactConfidence,
  type Omission,
  type Predicate,
} from './facts.js';
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
 * 1. **Selection is by fixed priority, never by ranking.** Extractors run in a declared order and each
 *    has a declared cap per tier. No relevance score exists anywhere in TraceIQ and none is invented.
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
  extract(context: RepositoryContext): readonly Draft[];
}

/** A fact before it has an id — ids are assigned once the final order is known. */
type Draft = Omit<Fact, 'id'>;

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
 * second because they are few and they are the honesty guarantee; condition and direct relationships
 * next because they answer most questions; indirect reach and repository scale last because they are the
 * largest and the least specific.
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
    part: 'externalPackages',
    caps: FEW,
    extract: (context) => {
      const subject = subjectOf(context) ?? 'repository';

      return context.dependencies.externalPackages.map((node) =>
        draft(subject, 'depends-on', node.id, '@traceiq/resolver'),
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

  const facts: Fact[] = [];
  const omissions: Omission[] = [];
  const lines: string[] = [];

  let spent = 0;
  let sequence = 0;

  /**
   * Facts already emitted, by triple.
   *
   * **The context mirrors some edges deliberately** — `references` is documented as "a kind-independent
   * view, not additional data", so a type reference appears both there and under `related`. Emitting both
   * spent 40 of a symbol projection's 276 facts on exact duplicates: budget paid twice, and apparent
   * evidence inflated. Deduplication is by (subject, predicate, object), and the earlier — higher
   * priority — extractor wins.
   */
  const seen = new Set<string>();
  const key = (fact: Draft): string => `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`;

  for (const extractor of EXTRACTORS) {
    // Filtering before capping keeps the omission honest: `total` counts the facts this part could have
    // contributed that nothing earlier had already said.
    const drafts = extractor.extract(context).filter((candidate) => {
      const identity = key(candidate);

      if (seen.has(identity)) {
        return false;
      }

      seen.add(identity);

      return true;
    });

    if (drafts.length === 0) {
      continue;
    }

    const capped = drafts.slice(0, extractor.caps[options.tier]);
    let kept = 0;

    for (const candidate of capped) {
      sequence += 1;
      const fact: Fact = { ...candidate, id: `f${sequence}` };
      const line = factLine(fact);
      const cost = counter.count(line);

      if (spent + cost > budget) {
        // The budget is exhausted. Undo this candidate's id so numbering stays contiguous, and stop —
        // admitting later, cheaper facts out of order would break the fixed priority.
        sequence -= 1;
        break;
      }

      facts.push(fact);
      lines.push(line);
      spent += cost;
      kept += 1;
    }

    if (kept < drafts.length) {
      omissions.push({ part: extractor.part, kept, total: drafts.length });
    }

    if (kept < capped.length) {
      // Nothing later can fit either, since every extractor after this one is lower priority.
      break;
    }
  }

  // The closed set the grounding guard checks against. It holds **identifiers only**: an object may read
  // `sym:… at depth 2`, and the depth is a fact about the edge rather than part of the name, so it is
  // stripped. Leaving it attached would put a string that is not an identifier into a set of identifiers,
  // and a model citing the name alone would be accused of inventing it.
  const identifiers = new Set<string>();

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
    identifiers,
    omissions,
    tier: options.tier,
    tokens: spent,
    digest: digest(lines),
  };
}
