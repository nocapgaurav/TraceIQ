/**
 * What a question is *about*, decided from the question alone.
 *
 * **This exists because a repository projection cannot be balanced and complete at the same time.** A
 * `standard` budget holds roughly 5,500 tokens of facts; `facebook/react` has 141 packages, 129 regions,
 * 120 hotspots, 333 dependencies and 37 role-bearing declarations, which is an order of magnitude more
 * than fits. Something must be dropped for every question, and dropping the same things for every
 * question means a question about technologies pays for hotspot rankings it will never use.
 *
 * **Keyword matching, and deliberately not a model.** Three reasons, in order of weight:
 *
 * 1. It must be *deterministic*. Everything below `generate` in this pipeline is reproducible, which is
 *    what makes an unexpected answer investigable by re-running the projection and comparing digests.
 *    A classifier that sampled would put a coin flip upstream of the evidence.
 * 2. It must be *free*. Prompt evaluation on the reference stack runs at 45.75 tokens per second, so a
 *    second model call to decide what the first should read would cost more than the saving.
 * 3. It must be *safe when wrong*. It is — see `INTENTS`. An intent only reorders what a **supplement**
 *    contains; the core facts every answer needs are projected first and identically regardless. A
 *    misclassified question gets a differently-ordered supplement, never a missing repository.
 *
 * Matching is on whole words against a lowercased question, so `packaging` does not match `package` and
 * a question mentioning `services` is not classified by the substring inside `microservices`.
 */

export const INTENTS = ['architecture', 'technology', 'hotspots', 'packages', 'overview'] as const;

export type QuestionIntent = (typeof INTENTS)[number];

/**
 * Which parts a given intent wants more of.
 *
 * Names the extractor parts from `projection.ts`. An intent is a **reordering of the supplement**, so
 * every part remains reachable under every intent — a part not listed here is simply projected after
 * the listed ones rather than excluded. That property is what makes a misclassification cheap.
 */
export const INTENT_PARTS: Readonly<Record<QuestionIntent, readonly string[]>> = {
  architecture: ['architecture', 'packages', 'regions', 'routes', 'cycles', 'composition'],
  technology: ['technologies', 'externalPackages', 'composition', 'regions'],
  hotspots: ['hotspots', 'health', 'cycles', 'impact-summary', 'incomingCalls'],
  packages: ['packages', 'architecture', 'externalPackages', 'cycles'],
  // A balanced question gets the declared order, which is already the balanced one.
  overview: [],
};

/**
 * The words that select each intent, in priority order.
 *
 * Ordered rather than scored: the first intent with a match wins, so two intents matching one question
 * resolve the same way every time. `technology` precedes `architecture` because "what frameworks does
 * the architecture use" is a technology question wearing an architecture word, and dependencies answer
 * it while role counts do not.
 */
const KEYWORDS: readonly (readonly [QuestionIntent, readonly string[]])[] = [
  [
    'technology',
    [
      'technology', 'technologies', 'framework', 'frameworks', 'dependency', 'dependencies',
      'library', 'libraries', 'language', 'languages', 'ecosystem', 'ecosystems', 'stack',
      'built', 'written', 'runtime', 'tooling', 'toolchain',
    ],
  ],
  [
    'hotspots',
    [
      'hotspot', 'hotspots', 'important', 'central', 'centrality', 'coupled', 'coupling',
      'referenced', 'connected', 'complex', 'complexity', 'risky', 'risk', 'impact', 'cycle',
      'cycles', 'fragile', 'critical',
    ],
  ],
  [
    'packages',
    ['package', 'packages', 'module', 'modules', 'owns', 'ownership', 'biggest', 'largest', 'component', 'components'],
  ],
  [
    'architecture',
    [
      'architecture', 'architectural', 'layer', 'layers', 'structure', 'structured', 'organised',
      'organized', 'service', 'services', 'boundary', 'boundaries', 'design', 'communicate',
      'communication', 'route', 'routes', 'endpoint', 'endpoints', 'controller', 'controllers',
      'entry', 'start', 'first', 'overview',
    ],
  ],
];

/**
 * Classifies one question.
 *
 * Falls back to `overview`, which is the balanced projection — so a question using none of the
 * vocabulary above loses nothing it would otherwise have had.
 */
export function intentOf(question: string): QuestionIntent {
  const words = new Set(question.toLowerCase().match(/[a-z]+/g) ?? []);

  for (const [intent, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => words.has(keyword))) {
      return intent;
    }
  }

  return 'overview';
}
