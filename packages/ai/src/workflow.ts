import type { RepositoryContext } from '@traceiq/context';

import { summariseArchitecture, type ArchitectureSummary } from './architecture.js';
import { ownRoutes } from './structure.js';

/**
 * What actually happens when this repository does its job.
 *
 * **A workflow is the one thing a new engineer asks for and an inventory can never supply.** "The
 * repository contains 6 controllers, 7 services and 14 repositories" is true and useless; "a redirect
 * arrives at `GET /:shortCode`, is handled by `redirectController`, which reads through Redis before
 * falling back to Prisma, and records the click" is the same graph facts arranged as a thing that
 * happens. Nothing else in TraceIQ produces the second sentence.
 *
 * **Two derivations, and they carry different confidence because they rest on different evidence.**
 * Keeping them apart is the whole reason this can be trusted:
 *
 * 1. **The handler chain is measured.** `RouteResult.handlers` is an ordered list of edges the
 *    Framework Extractor recorded, each linking a route to the declaration registered against it. That
 *    a request to `POST /login` reaches `requireJson` and then `loginController` is a fact with edges
 *    behind it, and it is emitted `CERTAIN`.
 * 2. **The continuation is conventional.** That `loginController` then calls `authService` which
 *    reaches `sessionRepository` is *not* measured — TraceIQ records that each declaration carries a
 *    role and that all three share the domain noun `auth`, not that one calls the next. It is emitted
 *    `INFERRED`, and the rendered step says so in its own words.
 *
 * A repository with no routes gets no route workflows, and one with no role layers gets no
 * continuation. React produces neither and that is correct: its workflow is a render pass, which no
 * amount of import-graph evidence describes.
 */

export interface WorkflowStep {
  /** What performs the step — a declaration name, a technology, or the request itself. */
  readonly actor: string;
  /** What happens there, in the graph's own terms. */
  readonly does: string;
  /** Why this step is claimed. */
  readonly evidence: string;
  /** `CERTAIN` for a recorded edge; `INFERRED` for a conventional continuation. */
  readonly confidence: 'CERTAIN' | 'INFERRED';
}

export interface Workflow {
  /** What the workflow is, named from what triggers it. */
  readonly name: string;
  /** What starts it — a method and path, or a domain. */
  readonly trigger: string;
  readonly steps: readonly WorkflowStep[];
  /** The domain this workflow belongs to, where one could be identified. */
  readonly domain: string | null;
  /** How many routes this one workflow stands for, when routes were grouped. */
  readonly routes: number;
}

/** How many workflows are worth deriving. Beyond this a reader is reading a list again. */
const WORKFLOW_LIMIT = 6;

/** Role layers in the order a request conventionally traverses them, after the handler. */
const CONTINUATION: readonly string[] = ['Service', 'Repository'];

/**
 * The workflows the graph supports, most-used trigger first.
 *
 * Routes are grouped by **the declaration that handles them**, not by path. Twelve routes answered by
 * one controller are one workflow with twelve entry points, and listing them separately would recreate
 * the inventory this exists to replace.
 */
export function workflowsOf(context: RepositoryContext): readonly Workflow[] {
  if (context.primary.type !== 'repository') {
    return [];
  }

  const architecture = summariseArchitecture(context);
  const routed = routeWorkflows(context, architecture);

  /*
   * The third derivation, and the only one that works on a repository with no analysable source.
   *
   * **A repository can state an order without any code establishing one.** A compose file declaring that
   * `api` depends on `seed`, which depends on `database`, is three steps in a determinate order — written by
   * the repository's authors, in the repository's own file, and invisible to every derivation above this
   * one. Asked to walk through a workflow, TraceIQ used to answer such a repository with a ranked component
   * list, because it had no workflow at all to narrate.
   *
   * It is placed *after* the routed workflows because a measured handler chain is the stronger evidence
   * where both exist, and before the conventional domain continuation because a declared prerequisite is
   * stronger than a role-layer convention.
   */
  const declared = routed.length >= WORKFLOW_LIMIT ? [] : artifactWorkflows(context);
  const named = [...routed, ...declared];

  // A repository with no routed workflows may still have layered domains — a queue consumer, a CLI, a
  // library with a service layer. Those are worth describing and rest on the same role annotations.
  const domains = named.length >= WORKFLOW_LIMIT ? [] : domainWorkflows(architecture, named);

  return [...named, ...domains].slice(0, WORKFLOW_LIMIT);
}

/**
 * Workflows an artefact **declares**, ordered by the prerequisites it states.
 *
 * **The only ordering in this file that is neither measured nor conventional: it is *stated*.** A compose
 * `depends_on`, a workflow `needs`, a Dockerfile `COPY --from` — each is the repository asserting that one
 * of its own parts must precede another, and each reaches the graph as a `DEPENDS_ON` edge between two
 * artefact elements. So the steps are `CERTAIN` in the sense that matters here — the declaration is
 * certain — and every step's evidence says in its own words that what was read is the declaration rather
 * than a run.
 *
 * A cycle in the declared prerequisites is not an error to reject. It is a repository that declared one, and
 * the members are emitted in their declared order with the cycle unbroken, because refusing to describe the
 * artefact would be a worse answer than describing it as it is written.
 */
function artifactWorkflows(context: RepositoryContext): readonly Workflow[] {
  if (context.primary.type !== 'repository') {
    return [];
  }

  const overview = context.primary.value.overview as {
    readonly keyArtifacts?: {
      readonly entries?: readonly {
        readonly path: string;
        readonly kind: string;
        readonly ordering: readonly string[];
      }[];
    };
  };

  const workflows: Workflow[] = [];

  for (const digest of overview.keyArtifacts?.entries ?? []) {
    if (digest.ordering.length === 0) {
      continue;
    }

    // `needs` is written as `dependent → prerequisite`, so the edge points backwards in time.
    const pairs = digest.ordering.flatMap((entry) => {
      const [dependent, prerequisite] = entry.split('→').map((part) => part.trim());

      return dependent === undefined || prerequisite === undefined || dependent === '' || prerequisite === ''
        ? []
        : [{ dependent, prerequisite }];
    });

    const ordered = topological(pairs);

    if (ordered.length < 2) {
      continue;
    }

    workflows.push({
      name: `${digest.path} — the order it declares`,
      trigger: digest.path,
      steps: ordered.map((name, index) => ({
        actor: name,
        does:
          index === 0
            ? 'runs first: nothing in this artefact declares a prerequisite for it'
            : `runs after ${ordered[index - 1] ?? ''}, which it declares it needs`,
        evidence: `${digest.path} declares this prerequisite; the artefact states the order and no run of it was observed`,
        confidence: 'CERTAIN',
      })),
      domain: null,
      routes: 0,
    });
  }

  return workflows;
}

/**
 * The declared prerequisites as a sequence, prerequisites first.
 *
 * Kahn's algorithm with a deterministic tie-break on name, so two scans of one repository produce the same
 * sequence. Anything left when no node has zero remaining prerequisites is a declared cycle, and it is
 * appended in name order rather than discarded — see `artifactWorkflows`.
 */
function topological(
  pairs: readonly { readonly dependent: string; readonly prerequisite: string }[],
): readonly string[] {
  const names = [...new Set(pairs.flatMap((pair) => [pair.dependent, pair.prerequisite]))].sort();
  const needs = new Map<string, Set<string>>(names.map((name) => [name, new Set<string>()]));

  for (const pair of pairs) {
    needs.get(pair.dependent)?.add(pair.prerequisite);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();

  for (let pass = 0; pass < names.length; pass += 1) {
    const ready = names
      .filter((name) => !placed.has(name))
      .filter((name) => [...(needs.get(name) ?? [])].every((need) => placed.has(need)));

    if (ready.length === 0) {
      break;
    }

    for (const name of ready) {
      placed.add(name);
      ordered.push(name);
    }
  }

  return [...ordered, ...names.filter((name) => !placed.has(name))];
}

/**
 * Workflows rooted in a recorded route → handler edge.
 *
 * The middleware that runs before the handler is included **in its recorded order**, because ordering
 * is the one thing about a middleware stack that matters and `handlers` preserves it by ordinal.
 */
function routeWorkflows(context: RepositoryContext, architecture: ArchitectureSummary): readonly Workflow[] {
  interface Group {
    readonly handler: string;
    readonly middleware: string[];
    readonly triggers: string[];
    count: number;
  }

  const groups = new Map<string, Group>();

  /** Nouns two or more role layers agreed on. The bar a name must clear to become a workflow's. */
  const capabilities = new Set(architecture.capabilities.map((capability) => capability.noun));

  /**
   * Declarations annotated Middleware, so a step can say what it is.
   *
   * Where the extractor could link only the middleware on a route — LinkForge's rate limiters, because
   * the controllers beside them did not resolve — the terminal handler *is* a middleware, and
   * describing it as the thing that "handles" the request overstates what the graph found.
   */
  const middlewareNames = new Set(
    architecture.layers.find((layer) => layer.role === 'Middleware')?.members ?? [],
  );

  /*
   * Only the routes the repository itself registers.
   *
   * A workflow rooted in a benchmark fixture's route is a workflow the repository *contains an example
   * of*, not one it performs — and `stripe/ai` produced six of them, named `create-checkout-session
   * requests` and `pay requests` and `products requests`, each traced through a different sample
   * application. Presenting those as what the repository does when it does its job is the most
   * confident form the fact soup took, because a workflow reads as a measurement.
   */
  for (const route of ownRoutes(context)) {
    // Defensive for the same reason `rankComponents` is: a route the extractor could not link to any
    // declaration carries no handlers, and a workflow without a handler is not a workflow.
    const linked = (route.handlers ?? []).filter((entry) => entry.declaration !== null);

    if (linked.length === 0) {
      continue;
    }

    const handler = linked.at(-1)?.declaration;

    if (handler === undefined || handler === null) {
      continue;
    }

    const held = groups.get(handler.id) ?? {
      handler: handler.name,
      middleware: linked.slice(0, -1).map((entry) => entry.declaration?.name ?? '').filter((name) => name !== ''),
      triggers: [],
      count: 0,
    };

    held.count += 1;

    if (held.triggers.length < 3) {
      held.triggers.push(`${route.method} ${route.composition.effectivePath}`);
    }

    groups.set(handler.id, held);
  }

  /**
   * Names already used, so two workflows never share one.
   *
   * Spring PetClinic mounts `initCreationForm`, `initFindForm` and `processFindForm` all under
   * `/owners`, and naming each after its first path segment produced three workflows called "owners
   * requests" — which reads as one workflow listed three times. Where the segment is already taken the
   * trigger is used, and it is unique by construction.
   */
  const used = new Set<string>();

  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.handler.localeCompare(right.handler))
    .slice(0, WORKFLOW_LIMIT)
    .map((group): Workflow => {
      const domain = domainOf(group.handler);
      const steps: WorkflowStep[] = [
        {
          actor: 'the request',
          does: `arrives at ${group.triggers.join(', ')}${group.count > group.triggers.length ? ` and ${group.count - group.triggers.length} more` : ''}`,
          evidence: 'routes extracted by the framework extractor',
          confidence: 'CERTAIN',
        },
      ];

      for (const name of group.middleware) {
        steps.push({
          actor: name,
          does: 'runs before the handler',
          evidence: 'registered against the route ahead of the handler, in this order',
          confidence: 'CERTAIN',
        });
      }

      const terminalIsMiddleware = middlewareNames.has(group.handler);

      steps.push({
        actor: group.handler,
        // Only the last *linked* handler is known. Where that handler is annotated Middleware the real
        // one was never resolved, and saying "handles it" would assert something the graph did not find.
        does: terminalIsMiddleware ? 'runs on it — the handler beyond it was not linked' : 'handles it',
        evidence: 'linked to the route by the framework extractor',
        confidence: 'CERTAIN',
      });

      steps.push(...continuation(architecture, domain));

      return {
        /*
         * Named for what it serves, not for whichever handler the extractor managed to link.
         *
         * LinkForge registers `router.post('/', createLimit, createUrlController)` and the extractor
         * linked only the rate limiter, so naming the workflow after its handler produced "limit
         * requests", "login limit requests" and "redirect limit requests" — three workflows named
         * after a cross-cutting concern rather than after anything the repository does. The route
         * prefix is the more honest name: it is what a request actually asks for, and it is a string
         * the extractor recorded rather than a noun stripped out of an identifier.
         */
        name: unique(workflowName(group.triggers[0] ?? '', domain, group.handler, capabilities), group.triggers[0] ?? '', used),
        trigger: group.triggers[0] ?? '',
        steps,
        domain,
        routes: group.count,
      };
    });
}

/**
 * The conventional continuation past the handler, for one domain.
 *
 * **Every step here is a declaration the graph annotated and whose name agrees with the domain — and
 * none of them is a call the graph observed.** The distinction is carried into the step itself rather
 * than left for a reader to infer, because a rendered arrow reads as a measurement whatever the
 * surrounding prose says.
 */
function continuation(architecture: ArchitectureSummary, domain: string | null): readonly WorkflowStep[] {
  if (domain === null) {
    return [];
  }

  const steps: WorkflowStep[] = [];

  for (const role of CONTINUATION) {
    const layer = architecture.layers.find((entry) => entry.role === role);
    const members = layer?.members.filter((member) => domainOf(member) === domain) ?? [];

    if (members.length === 0) {
      continue;
    }

    steps.push({
      actor: members.join(', '),
      does: role === 'Service' ? 'holds the behaviour for this domain' : 'reaches stored state for this domain',
      evidence: `annotated ${role} and named for ${domain}; the order is conventional, not an observed call`,
      confidence: 'INFERRED',
    });
  }

  // The cache before the store, because that is the order that makes a cache worth having — and both
  // are named only when the detection found them.
  for (const [entries, does] of [
    [architecture.cache, 'is where a repeated read is answered from, if it was cached'],
    [architecture.persistence, 'is where the state finally lives'],
  ] as const) {
    if (entries.length > 0) {
      steps.push({
        actor: entries.map((entry) => entry.name).join(', '),
        does,
        evidence: 'detected in the repository; that this workflow reaches it is not observed',
        confidence: 'INFERRED',
      });
    }
  }

  return steps;
}

/**
 * Workflows for domains that have layers but no route reaching them.
 *
 * Entirely `INFERRED`, and only emitted where **two or more** role layers name the same domain — one
 * `billingService` on its own is a file, while a `billingService` and a `BillingRepository` are two
 * independent annotations agreeing that billing is something this repository does.
 */
function domainWorkflows(architecture: ArchitectureSummary, existing: readonly Workflow[]): readonly Workflow[] {
  const covered = new Set(existing.map((workflow) => workflow.domain).filter((domain) => domain !== null));

  return architecture.capabilities
    .filter((capability) => !covered.has(capability.noun) && capability.layers.length >= 2)
    .slice(0, WORKFLOW_LIMIT)
    .map((capability): Workflow => ({
      name: `${capability.noun} handling`,
      trigger: `${capability.noun}, named in ${capability.layers.join(' and ')} declarations`,
      steps: [
        {
          actor: capability.members.join(', '),
          does: `carry the ${capability.noun} domain across ${capability.layers.join(' and ')}`,
          evidence: `${capability.layers.length} role layers independently name it; no call between them was observed`,
          confidence: 'INFERRED',
        },
        ...continuation(architecture, capability.noun),
      ],
      domain: capability.noun,
      routes: 0,
    }));
}

/** The name, or the trigger where the name is already taken. See `used`. */
function unique(name: string, trigger: string, used: Set<string>): string {
  const chosen = used.has(name) && trigger !== '' ? trigger : name;

  used.add(chosen);

  return chosen;
}

/**
 * What to call one routed workflow.
 *
 * Three candidates in falling order of how well each survives a handler the extractor could not
 * resolve: the **route prefix**, which is what the request asks for and is recorded verbatim; the
 * **domain**, where the handler's name yielded one; and the handler's own name as the last resort. A
 * root-path route has no prefix to use, which is the one case where the domain reads better.
 */
function workflowName(
  trigger: string,
  domain: string | null,
  handler: string,
  capabilities: ReadonlySet<string>,
): string {
  const path = trigger.split(' ')[1] ?? '';
  const segment = path.split('/').filter((part) => part !== '' && !part.startsWith(':'))[0];

  if (segment !== undefined && segment.length >= 2) {
    return `${segment} requests`;
  }

  /*
   * The domain only where the repository actually has one by that name.
   *
   * `domainOf` reduces whatever identifier happened to link, and on LinkForge that identifier is a
   * rate limiter — so `POST /` was named "limit requests" and `GET /:shortCode` "redirect limit
   * requests". A capability is a noun **two or more role layers independently agreed on**, which is
   * the same bar `architecture.ts` sets before calling something a domain at all. Anything that does
   * not clear it is a fragment of one identifier, and the route path says more.
   */
  if (domain !== null && capabilities.has(domain)) {
    return `${domain} requests`;
  }

  /*
   * The trigger verbatim, rather than the handler's name.
   *
   * A root-path route handled by an unresolved controller leaves only the middleware to name it after,
   * and LinkForge produced "limit requests" for `POST /` — a workflow named after a rate limiter. The
   * method and path are what the request actually asks for and are recorded exactly as written, so
   * they say strictly more than a noun stripped out of whichever identifier happened to link.
   */
  return trigger === '' ? `${handler} requests` : trigger;
}

/**
 * The domain a role-annotated name is about.
 *
 * The same reduction `architecture.ts` performs for capabilities, repeated here rather than exported
 * from there because the two answer different questions — that one asks which nouns *several* layers
 * agree on, this one asks what *one* declaration is about — and a shared helper would tie the meaning
 * of a capability to the naming of a route handler.
 */
function domainOf(name: string): string | null {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .filter(
      (word) =>
        word !== '' &&
        !/^(create|make|build|default|new|get|post|put|patch|delete|handle|handler)$/.test(word) &&
        !/^(controller|service|repository|repo|middleware|model|factory|provider)s?$/.test(word) &&
        !/^(prisma|redis|memory|inmemory|sql|http|default)$/.test(word),
    );

  const noun = words.join(' ').trim();

  return noun.length < 3 ? null : noun;
}

/**
 * One workflow as a single arrowed line, carrying what each step does.
 *
 * This is the **fact** rendering: it is the evidence a model cites, so it states what happens at every
 * step and says which half was measured. `renderWorkflowBrief` is the instruction rendering.
 */
export function renderWorkflow(workflow: Workflow): string {
  const steps = workflow.steps.map((step) => `${step.actor} (${step.does})`).join(' → ');
  const inferred = workflow.steps.some((step) => step.confidence === 'INFERRED');

  return `${workflow.name}: ${steps}${inferred ? ' — steps after the handler are conventional, not observed calls' : ''}`;
}

/**
 * The same workflow as actors alone.
 *
 * **For the instruction, where the detail is waste.** The guidance tells a model *which* workflows to
 * narrate; the `workflow` fact tells it what each step does, and the model cites that. Rendering both
 * in full cost LinkForge 457 tokens of question guidance — a quarter of its whole prompt — to say
 * twice what one `workflow` fact already said once. The chain is what the instruction needs; the
 * clauses are what the evidence carries.
 */
export function renderWorkflowBrief(workflow: Workflow): string {
  return `${workflow.name}: ${workflow.steps.map((step) => step.actor).join(' → ')}`;
}
