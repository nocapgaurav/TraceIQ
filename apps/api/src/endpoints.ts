import { RepositoryAnswerer, type LanguageModel } from '@traceiq/ai';
import type { AnalysisRegistry } from '@traceiq/analysis';
import type { NodeId } from '@traceiq/types';

import { readAnalysisUrl, unknownAnalysis, wireJob } from './analysis.js';

import { isAiError, parseChatRequest, toApiErrorFromAi, wireAnswer, wireGrounding } from './chat.js';
import {
  ApiError,
  badRequest,
  identifierMissingChain,
  invalidIdentifier,
  invalidPackageName,
  invalidRepository,
  missingParameter,
  unknownIdentifier,
  unknownPackage,
  unknownRoute,
  type ErrorCode,
} from './errors.js';
import type { GraphHolder } from './graph-holder.js';
import { API_VERSION } from './respond.js';
import type { EventSink } from './sse.js';

/** What a handler is given. Nothing else about the request reaches a capability. */
export interface RequestContext {
  /** Path parameters, with a wildcard already joined back into one string. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly holder: GraphHolder;
  /**
   * The model the application injected, or `null` when none was.
   *
   * **Constructor injection, no registry.** The API never selects a provider: the composition root builds
   * one, takes a model from it and passes it to `createApp`. That is why no vendor name appears anywhere
   * under `apps/api/src`, and why the chat endpoints answer `ai-not-configured` rather than starting a
   * provider of their own.
   */
  readonly model: LanguageModel | null;
  /** Aborted when the client disconnects, so a cancelled request stops the model generating. */
  readonly signal: AbortSignal;
  /**
   * Analyses in flight and recently finished.
   *
   * Injected for the same reason the model is: the API owns no analysis state of its own, and a test
   * supplies a registry over a fake cloner without a network.
   */
  readonly analyses: AnalysisRegistry;
  /** Whether analyses run in a worker. Observed from the wiring so `/healthz` cannot overstate it. */
  readonly analysisOutOfProcess: boolean;
}

/** Builds the answerer for one request, over the graph that request already opened. */
export function answererFor(context: RequestContext): RepositoryAnswerer {
  if (context.model === null) {
    throw new ApiError(
      'ai-not-configured',
      'this server was started without a language model',
      'start the API with a model configured, or use the CLI',
    );
  }

  return new RepositoryAnswerer(context.holder.capabilities().context(), context.model);
}

export interface ParameterSpec {
  readonly name: string;
  readonly location: 'path' | 'query';
  readonly required: boolean;
  readonly description: string;
  readonly example: string;
}

export interface Endpoint {
  readonly method: 'get' | 'post';
  /** Express path, using `*name` for a parameter that may contain slashes. */
  readonly path: string;
  /** The same path in OpenAPI form, using `{name}`. */
  readonly documentedPath: string;
  readonly operationId: string;
  readonly summary: string;
  /** Which package produced the payload. Recorded in `meta.capability`. */
  readonly capability: string;
  readonly parameters: readonly ParameterSpec[];
  readonly requestBody?: { readonly description: string; readonly example: unknown };
  /** Errors this endpoint can return, beyond the ones every endpoint can. */
  readonly errors: readonly ErrorCode[];
  /**
   * Produces the payload. Exactly one of `handle` and `stream` is present.
   *
   * A `handle` endpoint returns a value that the app wraps in the standard envelope. A `stream` endpoint
   * writes frames itself, because once the first byte is sent the status line is gone and the envelope no
   * longer applies. Keeping both in this table means routing, validation and the OpenAPI document still
   * have a single source of truth.
   */
  handle?(context: RequestContext): Promise<unknown> | unknown;
  stream?(context: RequestContext, sink: EventSink): Promise<void>;
}

const IDENTITY_PREFIX = /^(sym|file|route|env|ext):/;

/** When this process started. Fixed at import so uptime is the process's, not the request's. */
const STARTED_AT = new Date().toISOString();

/**
 * Every endpoint, and the single source of truth for routing, validation and the OpenAPI document.
 *
 * A handler **adapts and delegates**: it reads parameters, validates their shape, calls one capability
 * and returns its result unchanged. There is no repository intelligence here — no traversal, no
 * assembly, no interpretation — and an endpoint that reshaped a result would be inventing information.
 */
export const ENDPOINTS: readonly Endpoint[] = [
  {
    method: 'get',
    path: '/ping',
    documentedPath: '/ping',
    operationId: 'ping',
    summary: 'Liveness check. Answers without opening a graph.',
    capability: 'api',
    parameters: [],
    errors: [],
    handle() {
      return { status: 'ok' };
    },
  },
  {
    method: 'get',
    path: '/version',
    documentedPath: '/version',
    operationId: 'version',
    summary: 'API version and whether a graph has been scanned.',
    capability: 'api',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return { version: API_VERSION, scanned: holder.isScanned(), databasePath: holder.databasePath };
    },
  },
  {
    method: 'get',
    path: '/healthz',
    documentedPath: '/healthz',
    operationId: 'healthz',
    summary: 'What is deployed, what it is serving and what is running.',
    capability: 'api',
    parameters: [],
    errors: [],
    /**
     * The endpoint that stops a stale deployment being reported as a product bug.
     *
     * **This exists because it already happened.** Three milestones of capability were present in
     * source and absent from the running product, and the symptom was a repository being refused with a
     * message that no longer existed in the code. Hours went into looking for a gate that had been
     * deleted. Every field here is something that was, at some point, silently different from what
     * somebody assumed — the build, the schema, the model, the graph being served.
     *
     * Deliberately not `/health`: that name belongs to the repository health report, and two things
     * called health in one API is exactly the kind of ambiguity this endpoint exists to remove.
     */
    handle({ holder, model, analyses, analysisOutOfProcess }) {
      const scanned = holder.isScanned();

      return {
        status: 'ok',
        api: {
          version: API_VERSION,
          // Stamped into the image at build time. `unknown` locally, which is honest: a working tree
          // has no commit that describes what is running.
          commit: process.env.TRACEIQ_COMMIT ?? 'unknown',
          builtAt: process.env.TRACEIQ_BUILT_AT ?? 'unknown',
          startedAt: STARTED_AT,
          uptimeMs: Math.round(process.uptime() * 1000),
          pid: process.pid,
          nodeVersion: process.version,
          rssBytes: process.memoryUsage.rss(),
        },
        graph: {
          databasePath: holder.databasePath,
          scanned,
          // The graph's own account of what it can answer, rather than this file's opinion of it.
          repository: scanned ? holder.capabilities().explorer().overview().repository.files : null,
          // What the graph says it can answer, by region — depth, languages, why. Read from the
          // overview so this endpoint asserts nothing the dashboard does not already show.
          capabilities: scanned ? holder.capabilities().explorer().overview().capabilities : null,
        },
        analysis: {
          running: analyses.active().length,
          queued: analyses.queued(),
          /*
           * Observed, not declared.
           *
           * The first version of this line was the constant `false`, written the same afternoon a
           * missed option meant every analysis really did run inline while the startup banner claimed
           * otherwise. A health endpoint that repeats an intention is worse than no health endpoint.
           */
          outOfProcess: analysisOutOfProcess,
        },
        model: model === null ? null : { id: model.describe().id, contextWindow: model.describe().contextWindow },
      };
    },
  },
  {
    method: 'post',
    path: '/scan',
    documentedPath: '/scan',
    operationId: 'scan',
    summary: 'Build the repository graph and store it, replacing any existing graph.',
    capability: 'pipeline',
    parameters: [],
    requestBody: { description: 'The repository to scan.', example: { repository: '/path/to/repo' } },
    errors: ['bad-request', 'missing-parameter', 'invalid-repository'],
    async handle({ body, holder }) {
      const repository = readRepository(body);

      let summary;

      try {
        summary = await holder.pipeline.scan({
          repositoryPath: repository,
          databasePath: holder.databasePath,
          createdAt: FIXED_CREATED_AT,
        });
      } catch (error) {
        throw invalidRepository(repository, error instanceof Error ? error.message : 'unreadable');
      }

      // Swapped only once the new graph is written, in one synchronous step.
      holder.reopen();

      return summary;
    },
  },
  /*
   * Repository Analysis.
   *
   * `POST /scan` above stays exactly as it was — a synchronous scan of a path already on this machine.
   * These three add the other half: a public GitHub URL, cloned into a temporary workspace and handed to
   * the same `RepositoryPipeline`. Nothing here analyses anything; every handler is a call into the
   * registry and a wire projection.
   */
  {
    method: 'post',
    path: '/analysis',
    documentedPath: '/analysis',
    operationId: 'startAnalysis',
    summary: 'Analyse a public GitHub repository: clone it, scan it, and replace the stored graph.',
    capability: 'analysis',
    parameters: [],
    requestBody: {
      description: 'The public GitHub repository to analyse.',
      example: { url: 'https://github.com/facebook/react' },
    },
    errors: ['bad-request', 'missing-parameter'],
    handle({ body, holder, analyses }) {
      const url = readAnalysisUrl(body);

      /*
       * A database of its own, adopted only if it succeeds.
       *
       * The live graph is never the thing being written. That is what makes two analyses safe to run at
       * once — they cannot collide over one file — and it is also why a failed analysis no longer
       * damages the graph a user was reading: the half-written file is simply discarded. `holder.stage`
       * hands out the path; `holder.adopt` swaps it in.
       */
      const staged = holder.stage();
      const outcome = analyses.start({ url, databasePath: staged, createdAt: FIXED_CREATED_AT });

      holder.bind(outcome.job.id, staged);

      return { accepted: outcome.accepted, job: wireJob(outcome.job) };
    },
  },
  {
    method: 'get',
    path: '/analysis',
    documentedPath: '/analysis',
    operationId: 'listAnalyses',
    summary: 'Analyses in flight and recently finished, newest first.',
    capability: 'analysis',
    parameters: [],
    errors: [],
    handle({ analyses }) {
      return {
        running: analyses.running() === null ? null : wireJob(analyses.running() as NonNullable<ReturnType<typeof analyses.running>>),
        entries: analyses.list().map(wireJob),
      };
    },
  },
  {
    method: 'post',
    path: '/analysis/:id/cancel',
    documentedPath: '/analysis/{id}/cancel',
    operationId: 'cancelAnalysis',
    summary: 'Stop an analysis that is queued or running.',
    capability: 'analysis',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description: 'The analysis id returned when it was started.',
        example: 'analysis-1',
      },
    ],
    errors: ['not-found'],
    handle({ params, analyses }) {
      const id = params.id ?? '';
      const job = analyses.get(id);

      if (job === undefined) {
        throw unknownAnalysis(id);
      }

      // `false` means it had already settled, which is not an error: the caller wanted it stopped and
      // it is stopped. The job is returned so they can see how it actually ended.
      const stopped = analyses.cancel(id);

      return { stopped, job: wireJob(analyses.get(id) ?? job) };
    },
  },
  {
    method: 'post',
    path: '/analysis/:id/retry',
    documentedPath: '/analysis/{id}/retry',
    operationId: 'retryAnalysis',
    summary: 'Run a settled analysis again, as a new job.',
    capability: 'analysis',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description: 'The analysis id to run again.',
        example: 'analysis-1',
      },
    ],
    errors: ['not-found', 'bad-request'],
    handle({ params, holder, analyses }) {
      const id = params.id ?? '';

      if (analyses.get(id) === undefined) {
        throw unknownAnalysis(id);
      }

      const staged = holder.stage();
      const outcome = analyses.retry(id, { databasePath: staged });

      if (outcome === null) {
        holder.discard(staged);

        throw badRequest(
          `analysis ${id} has not finished`,
          'cancel it first, or wait for it to settle before retrying',
        );
      }

      // A new job with a new id, so the original's stages and error survive as the evidence of why a
      // retry was wanted. Its staged database is its own for the same reason.
      holder.bind(outcome.job.id, staged);

      return { accepted: outcome.accepted, job: wireJob(outcome.job) };
    },
  },
  {
    method: 'get',
    // `*id` rather than `:id`. An analysis id contains no slash, so the wildcard is not needed here —
    // but every other path parameter in this table is one, and keeping the rule "a path parameter is a
    // wildcard" without exception is what lets a test check it mechanically.
    path: '/analysis/*id',
    documentedPath: '/analysis/{id}',
    operationId: 'analysis',
    summary: 'One analysis, with its current stage. Poll this while an analysis is running.',
    capability: 'analysis',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description: 'The analysis id returned when it was started.',
        example: 'analysis-1',
      },
    ],
    errors: ['not-found'],
    handle({ params, analyses }) {
      const id = params.id ?? '';
      const job = analyses.get(id);

      if (job === undefined) {
        throw unknownAnalysis(id);
      }

      // A failed analysis is a 200: the request to read it succeeded, and the failure is in the payload.
      return wireJob(job);
    },
  },
  {
    method: 'get',
    path: '/overview',
    documentedPath: '/overview',
    operationId: 'overview',
    summary: 'Repository, architecture, package, graph and health summary.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().overview();
    },
  },
  {
    method: 'get',
    path: '/architecture',
    documentedPath: '/architecture',
    operationId: 'architecture',
    summary: 'Architecture, package, role and dependency trees.',
    capability: 'navigation',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().navigator().architecture();
    },
  },
  {
    method: 'get',
    path: '/packages',
    documentedPath: '/packages',
    operationId: 'listPackages',
    summary: 'Every derived package with its counts.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().browsePackages();
    },
  },
  {
    method: 'get',
    path: '/packages/*name',
    documentedPath: '/packages/{name}',
    operationId: 'getPackage',
    summary: 'One package: files, dependencies, dependents, roles.',
    capability: 'explorer',
    parameters: [
      {
        name: 'name',
        location: 'path',
        required: true,
        description: 'Package name as GET /packages reports it. May contain slashes.',
        example: 'packages/health',
      },
    ],
    errors: ['missing-parameter', 'invalid-package-name', 'unknown-package'],
    handle({ params, holder }) {
      const name = required(params.name, 'name', 'path');

      if (name.includes('..') || name.startsWith('/')) {
        throw invalidPackageName(name);
      }

      const view = holder.capabilities().explorer().browsePackage(name);

      if (view === null) {
        throw unknownPackage(name);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/files/*path',
    documentedPath: '/files/{path}',
    operationId: 'getFile',
    summary: 'One file: declarations, imports, exports, routes, statistics.',
    capability: 'explorer',
    parameters: [
      {
        name: 'path',
        location: 'path',
        required: true,
        description: 'Repository-relative file path. May contain slashes. A file: prefix is optional.',
        example: 'packages/health/src/types.ts',
      },
    ],
    errors: ['missing-parameter', 'unknown-identifier'],
    handle({ params, holder }) {
      const path = required(params.path, 'path', 'path');
      const id = (path.startsWith('file:') ? path : `file:${path}`) as NodeId;
      const view = holder.capabilities().explorer().browseFile(id);

      if (view === null) {
        throw unknownIdentifier(path);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/symbol/*id',
    documentedPath: '/symbol/{id}',
    operationId: 'getSymbol',
    summary: 'Everything the repository records about one declaration.',
    capability: 'explorer+explain+impact+health',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description:
          'Declaration identifier. Slashes are sent as-is; the # MUST be percent-encoded as %23, since it otherwise starts a URL fragment and the rest is stripped before the request is sent.',
        example: 'sym:packages/health/src/graph-index.ts%23buildGraphIndex',
      },
    ],
    errors: ['missing-parameter', 'invalid-identifier', 'unknown-identifier'],
    handle({ params, holder }) {
      const id = declarationIdentifier(required(params.id, 'id', 'path'));
      const view = holder.capabilities().explorer().browseSymbol(id);

      if (view === null) {
        throw unknownIdentifier(id);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/impact/*id',
    documentedPath: '/impact/{id}',
    operationId: 'getImpact',
    summary: 'What a change to one declaration could affect.',
    capability: 'impact',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description: 'Declaration identifier. The # must be percent-encoded as %23.',
        example: 'sym:packages/health/src/graph-index.ts%23buildGraphIndex',
      },
    ],
    errors: ['missing-parameter', 'invalid-identifier', 'unknown-identifier'],
    handle({ params, holder }) {
      const id = declarationIdentifier(required(params.id, 'id', 'path'));
      const result = holder.capabilities().impact().analyze(id);

      if (result === null) {
        throw unknownIdentifier(id);
      }

      return result;
    },
  },
  {
    method: 'get',
    path: '/routes',
    documentedPath: '/routes',
    operationId: 'listRoutes',
    summary: 'Every route the repository registers.',
    capability: 'navigation',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().navigator().routes();
    },
  },
  {
    method: 'get',
    path: '/route',
    documentedPath: '/route',
    operationId: 'getRoute',
    summary: 'One route: chain, roles reached, dependencies, health.',
    capability: 'navigation',
    parameters: [
      { name: 'method', location: 'query', required: true, description: 'HTTP method as registered.', example: 'GET' },
      { name: 'path', location: 'query', required: true, description: 'Route path as written at the registration.', example: '/users/:id' },
    ],
    errors: ['missing-parameter', 'unknown-route'],
    handle({ query, holder }) {
      const method = required(query.method, 'method', 'query');
      const path = required(query.path, 'path', 'query');
      const view = holder.capabilities().navigator().explainRoute({ method, path });

      if (view === null) {
        throw unknownRoute(method, path);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/health',
    documentedPath: '/health',
    operationId: 'getHealth',
    summary: 'Architectural health report. Not a liveness check — see /ping.',
    capability: 'health',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().health().analyze();
    },
  },
  {
    method: 'get',
    path: '/search',
    documentedPath: '/search',
    operationId: 'search',
    summary: 'Exact or prefix search, alphabetical. Never ranked.',
    capability: 'explorer',
    parameters: [
      { name: 'q', location: 'query', required: true, description: 'Text matched against a name and an identifier.', example: 'buildGraph' },
      { name: 'kind', location: 'query', required: false, description: 'Restrict to one node kind.', example: 'Class' },
      { name: 'path', location: 'query', required: false, description: 'Restrict to a path prefix.', example: 'packages/health' },
      { name: 'match', location: 'query', required: false, description: 'prefix (default) or exact.', example: 'exact' },
    ],
    errors: ['missing-parameter', 'bad-request'],
    handle({ query, holder }) {
      const text = required(query.q, 'q', 'query');
      const match = matchMode(query.match);

      return holder
        .capabilities()
        .explorer()
        .search({
          text,
          ...(query.kind === undefined ? {} : { kind: query.kind as never }),
          ...(query.path === undefined ? {} : { path: query.path }),
          ...(match === undefined ? {} : { match }),
        });
    },
  },
  {
    method: 'get',
    path: '/dependencies/*id',
    documentedPath: '/dependencies/{id}',
    operationId: 'getDependencies',
    summary: 'Direct and transitive dependencies of a package, file, declaration or route.',
    capability: 'navigation',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        description:
          'An identifier, or a package name when it carries no identity prefix. A # in an identifier must be percent-encoded as %23.',
        example: 'packages/health',
      },
    ],
    errors: ['missing-parameter', 'unknown-identifier'],
    handle({ params, holder }) {
      const value = required(params.id, 'id', 'path');
      const navigator = holder.capabilities().navigator();
      const view = IDENTITY_PREFIX.test(value)
        ? navigator.dependencies(value as NodeId)
        : navigator.dependencies({ package: value });

      if (view === null) {
        throw unknownIdentifier(value);
      }

      return view;
    },
  },
  {
    method: 'get',
    path: '/cycles',
    documentedPath: '/cycles',
    operationId: 'getCycles',
    summary: 'Every import, call, reference and inheritance cycle.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().cycles();
    },
  },
  {
    method: 'get',
    path: '/hotspots',
    documentedPath: '/hotspots',
    operationId: 'getHotspots',
    summary: 'The most connected declarations and files.',
    capability: 'explorer',
    parameters: [],
    errors: [],
    handle({ holder }) {
      return holder.capabilities().explorer().hotspots();
    },
  },
  {
    method: 'post',
    path: '/chat',
    documentedPath: '/chat',
    operationId: 'chat',
    summary: 'Answer one question about the repository, grounded in projected context.',
    capability: '@traceiq/ai',
    parameters: [],
    requestBody: {
      description:
        'The question and an already-resolved subject. This endpoint does not search: use GET /search to find an identifier first, because turning free text into a subject is repository intelligence and does not belong in the AI path.',
      example: {
        question: 'What would break if I changed this?',
        subject: { kind: 'impact', id: 'sym:src/auth/user.service.ts#UserService.login' },
      },
    },
    errors: [
      'ai-not-configured',
      'provider-unavailable',
      'model-not-found',
      'model-load-failed',
      'subject-not-found',
      'context-source-failed',
      'budget-not-satisfiable',
      'context-window-exceeded',
      'generation-timeout',
      'generation-aborted',
      'stream-interrupted',
      'provider-protocol-error',
    ],
    handle: async (context) => {
      const request = parseChatRequest(context.body);
      const answerer = answererFor(context);

      try {
        // The whole answer, drained from the streaming primitive. `/chat` exists for a caller that wants
        // one JSON response; it is not a second code path.
        let answer = null;

        for await (const event of answerer.answer(toAnswerRequest(request), context.signal)) {
          if (event.type === 'complete') {
            answer = event.answer;
          }
        }

        if (answer === null) {
          throw new ApiError('stream-interrupted', 'the answer never completed', 'try again');
        }

        return wireAnswer(answer);
      } catch (cause) {
        throw isAiError(cause) ? toApiErrorFromAi(cause) : cause;
      }
    },
  },
  {
    method: 'post',
    path: '/chat/stream',
    documentedPath: '/chat/stream',
    operationId: 'chatStream',
    summary: 'The same answer as POST /chat, streamed as server-sent events.',
    capability: '@traceiq/ai',
    parameters: [],
    requestBody: {
      description:
        'Identical to POST /chat. The response is text/event-stream with five event types: open, grounding (always before any delta), delta, complete, and error. A failure after the first byte arrives as a terminal error frame, because the status line has already been sent.',
      example: {
        question: 'What does this declaration take part in?',
        subject: { kind: 'symbol', id: 'sym:src/auth/user.service.ts#UserService.login' },
      },
    },
    errors: [
      'ai-not-configured',
      'provider-unavailable',
      'model-not-found',
      'subject-not-found',
      'budget-not-satisfiable',
      'generation-timeout',
      'stream-interrupted',
      'provider-protocol-error',
    ],
    stream: async (context, sink) => {
      // Validation and answerer construction happen before the stream opens, so a malformed request is
      // still an ordinary JSON error with a real status rather than a 200 carrying an error frame.
      const request = parseChatRequest(context.body);
      const answerer = answererFor(context);

      const description = context.model?.describe() ?? null;

      sink.send('open', {
        model: description?.id ?? null,
        // The window the prompt is genuinely budgeted against, so a slow answer can be understood
        // rather than guessed at. See `OllamaModelOptions.contextWindow`.
        contextWindow: description?.contextWindow ?? null,
      });

      /**
       * Whether the answer reached a terminal frame.
       *
       * **A stream that ends without one leaves the UI spinning forever, and that is the failure this
       * milestone exists to remove.** Every path below must set this — the loop completing, a throw, or
       * the iterator ending early — and the guard afterwards turns "somehow neither" into a named error
       * instead of a silence.
       */
      let settled = false;

      try {
        for await (const event of answerer.answer(toAnswerRequest(request), context.signal)) {
          if (!sink.open) {
            // The client has gone. Returning ends the iteration, which aborts the model through
            // `signal`. There is nobody to send a terminal frame to, so not sending one is correct
            // rather than a gap.
            settled = true;

            return;
          }

          if (event.type === 'status') {
            sink.send('status', { phase: event.phase });
          } else if (event.type === 'grounding') {
            sink.send('grounding', wireGrounding(event.grounding));
          } else if (event.type === 'delta') {
            sink.send('delta', { text: event.text });
          } else {
            settled = true;
            sink.send('complete', wireAnswer(event.answer));
          }
        }

        if (!settled && sink.open) {
          // The iterator finished without completing. Unreachable through `RepositoryAnswerer`, which
          // always ends with `complete` or throws — but a stream that ends silently is the one failure
          // a client cannot recover from, so it is named rather than trusted away.
          settled = true;
          sink.send('error', {
            code: 'stream-interrupted',
            detail: 'the answer ended before it completed',
            hint: 'ask again',
            partial: null,
          });
        }
      } catch (cause) {
        settled = true;

        // The client disconnecting aborts the model by design, and the resulting `generation-aborted`
        // is the *consequence* of the disconnect rather than a fault to report. Distinguishing it from
        // a provider that aborted on its own is what stops a cancelled answer being logged and rendered
        // as a failure.
        if (!sink.open) {
          return;
        }

        const error = isAiError(cause) ? toApiErrorFromAi(cause) : toUnexpected(cause);

        sink.send('error', {
          code: error.code,
          detail: error.detail,
          hint: error.hint,
          partial: isAiError(cause) ? cause.partial : null,
        });
      } finally {
        sink.close();
      }
    },
  },
];

/** The chat body, as the AI layer's request. Nothing is added: the fields map one to one. */
function toAnswerRequest(request: ReturnType<typeof parseChatRequest>): Parameters<RepositoryAnswerer['answer']>[0] {
  return {
    question: request.question,
    subject: request.subject,
    ...(request.tier === undefined ? {} : { tier: request.tier }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.history === undefined
      ? {}
      : {
          history: {
            // Prior turns carry only their question and answer. Facts are never replayed — a fact from turn
            // one could otherwise still be grounding turn eight after a rescan.
            turns: request.history.map((turn, index) => ({
              id: String(index),
              question: turn.question,
              answer: turn.answer,
              subject: request.subject,
              citations: [],
              verdict: 'unverifiable' as const,
              projectionDigest: '',
              model: '',
            })),
          },
        }),
  };
}

function toUnexpected(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError('context-source-failed', cause instanceof Error ? cause.message : String(cause), 'see server logs');
}

/**
 * The revision timestamp a scan stamps into the store.
 *
 * Fixed rather than read from the clock, so two scans of one repository write identical databases. No
 * read exposes it, so the only thing a live clock would change is reproducibility.
 */
const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

export function findEndpoint(method: string, documentedPath: string): Endpoint | undefined {
  return ENDPOINTS.find(
    (endpoint) => endpoint.method === method.toLowerCase() && endpoint.documentedPath === documentedPath,
  );
}

/** Methods any endpoint declares for a documented path, for a 405. */
export function methodsFor(documentedPath: string): readonly string[] {
  return ENDPOINTS.filter((endpoint) => endpoint.documentedPath === documentedPath).map((endpoint) =>
    endpoint.method.toUpperCase(),
  );
}

function required(value: string | undefined, name: string, where: 'query' | 'body' | 'path'): string {
  if (value === undefined || value === '') {
    throw missingParameter(name, where);
  }

  return value;
}

function identifier(value: string): NodeId {
  if (!IDENTITY_PREFIX.test(value)) {
    throw invalidIdentifier(value);
  }

  return value as NodeId;
}

/**
 * A declaration identifier: `sym:<path>#<chain>`.
 *
 * The `#` is required, so an identifier truncated by URL fragment handling is caught here as a 400
 * naming the fix rather than reaching the graph and coming back as a puzzling 404.
 */
function declarationIdentifier(value: string): NodeId {
  const id = identifier(value);

  if (!value.startsWith('sym:') || !value.includes('#')) {
    throw identifierMissingChain(value);
  }

  return id;
}

function matchMode(value: string | undefined): 'prefix' | 'exact' | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== 'prefix' && value !== 'exact') {
    throw badRequest(`'${value}' is not a match mode`, "match must be 'prefix' or 'exact'");
  }

  return value;
}

function readRepository(body: unknown): string {
  if (body === null || typeof body !== 'object') {
    throw missingParameter('repository', 'body');
  }

  const value = (body as { readonly repository?: unknown }).repository;

  if (typeof value !== 'string' || value === '') {
    throw missingParameter('repository', 'body');
  }

  return value;
}
