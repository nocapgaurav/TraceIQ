import { ENDPOINTS } from './endpoints.js';
import { ERROR_CODES, HTTP_STATUS, type ErrorCode } from './errors.js';
import { API_VERSION } from './respond.js';

/**
 * The OpenAPI 3 document, generated from the endpoint table.
 *
 * Generated rather than written, so it cannot drift from the routes: adding an endpoint to `ENDPOINTS`
 * adds it here, and a parameter documented in one place is the parameter the handler validates.
 *
 * Payload schemas are described as objects rather than enumerated field by field. A capability result
 * is returned **unchanged**, and its shape is defined by the capability's own published types — copying
 * those into a second definition here would create two sources of truth for one payload, and the copy
 * would be the one that rots. `x-capability` names which package defines each one.
 */
export function openApiDocument(): Readonly<Record<string, unknown>> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'TraceIQ API',
      version: API_VERSION,
      description:
        'HTTP access to the TraceIQ repository intelligence engine. Every response carries success, data and meta; data is a capability result returned unchanged. Nothing here is predicted, ranked or generated.',
    },
    servers: [{ url: '/', description: 'The server this document was fetched from.' }],
    paths: pathsObject(),
    components: {
      schemas: {
        Meta: {
          type: 'object',
          required: ['endpoint', 'capability', 'graphApiCalls'],
          description:
            'Deterministic for identical input. The request identifier and elapsed time are headers rather than fields, so a body can be compared and cached.',
          properties: {
            endpoint: { type: 'string', example: '/symbol/{id}' },
            capability: { type: 'string', example: 'explorer+explain+impact+health' },
            graphApiCalls: { type: 'integer', example: 2484 },
          },
        },
        Error: {
          type: 'object',
          required: ['success', 'error', 'meta'],
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'detail', 'hint'],
              properties: {
                code: { type: 'string', enum: [...ERROR_CODES] },
                detail: { type: 'string', description: 'Names the specific thing that was wrong.' },
                hint: { type: 'string', description: 'Fixed per code. Says what to do next.' },
              },
            },
            meta: { $ref: '#/components/schemas/Meta' },
          },
        },
      },
      headers: {
        RequestId: { description: 'Identifies this request in the log.', schema: { type: 'string' } },
        ResponseTime: { description: 'Elapsed server time.', schema: { type: 'string', example: '4.201ms' } },
        Version: { description: 'API version.', schema: { type: 'string', example: API_VERSION } },
      },
    },
  };
}

function pathsObject(): Readonly<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of ENDPOINTS) {
    const operation: Record<string, unknown> = {
      operationId: endpoint.operationId,
      summary: endpoint.summary,
      'x-capability': endpoint.capability,
      responses:
        endpoint.stream === undefined
          ? responsesFor(endpoint.method === 'post' ? 201 : 200, endpoint.errors, endpoint.capability)
          : streamResponsesFor(endpoint.errors),
    };

    if (endpoint.parameters.length > 0) {
      operation.parameters = endpoint.parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.location,
        required: parameter.required,
        description: parameter.description,
        schema: { type: 'string' },
        example: parameter.example,
      }));
    }

    if (endpoint.requestBody !== undefined) {
      operation.requestBody = {
        required: true,
        description: endpoint.requestBody.description,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['repository'],
              properties: { repository: { type: 'string', description: 'Path to the repository to scan.' } },
            },
            example: endpoint.requestBody.example,
          },
        },
      };
    }

    const forPath = paths[endpoint.documentedPath] ?? {};

    forPath[endpoint.method] = operation;
    paths[endpoint.documentedPath] = forPath;
  }

  return paths;
}

/**
 * Every response an operation can produce.
 *
 * The success status, the errors the endpoint declares, and the three errors any endpoint can produce:
 * a missing graph, an unsupported method and a not-found path. Each error status appears once, with the
 * codes that map to it, so a client reading the document sees exactly which codes to expect where.
 */
/**
 * A streaming endpoint's responses.
 *
 * `200` with `text/event-stream` rather than the standard envelope: once frames are flowing the status is
 * fixed, so a failure arrives as a terminal `error` frame instead of a status. The frame vocabulary is
 * documented here because a client cannot discover it from a schema.
 */
function streamResponsesFor(errors: readonly ErrorCode[]): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '200': {
      description:
        'A server-sent event stream. Events, in order: `open` once; `grounding` before any prose, and again if the prompt had to be re-projected smaller; `delta` per token; then either `complete` with the whole answer, or `error` if generation failed after the stream had opened.',
      content: {
        'text/event-stream': {
          schema: { type: 'string' },
          example:
            // `restart` is shown because a client that ignores it renders a rejected answer until
            // `complete` arrives. It appears at most once per answer, immediately before the one bounded
            // corrective generation, and means: discard the prose so far.
            'event: open\ndata: {"model":"qwen2.5:7b-instruct"}\n\nevent: grounding\ndata: {"kind":"symbol","factCount":166,"tier":"standard","tokens":5995,"digest":"52a4aca4a122a3e1","omissions":[]}\n\nevent: delta\ndata: {"text":"It is a method "}\n\nevent: restart\ndata: {"reasons":["execution-order: the facts carry no workflow…"]}\n\nevent: status\ndata: {"phase":"correcting"}\n\nevent: delta\ndata: {"text":"It is a method "}\n\nevent: complete\ndata: {"verdict":"grounded","attempts":2,"citations":[…]}\n\n',
        },
      },
    },
  };

  // A failure detected *before* the first frame is still an ordinary JSON error with a real status.
  for (const status of new Set(errors.map((code) => HTTP_STATUS[code]))) {
    responses[String(status)] = {
      description: 'A failure raised before the stream opened.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  return responses;
}

function responsesFor(
  successStatus: number,
  declared: readonly ErrorCode[],
  capability: string,
): Readonly<Record<string, unknown>> {
  const codes = [...new Set<ErrorCode>([...declared, 'repository-not-scanned'])];
  const byStatus = new Map<number, ErrorCode[]>();

  for (const code of codes) {
    const status = HTTP_STATUS[code];

    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  const responses: Record<string, unknown> = {
    [String(successStatus)]: {
      description: 'The capability result, returned unchanged.',
      headers: {
        'x-request-id': { $ref: '#/components/headers/RequestId' },
        'x-response-time': { $ref: '#/components/headers/ResponseTime' },
        'x-traceiq-version': { $ref: '#/components/headers/Version' },
      },
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success', 'data', 'meta'],
            properties: {
              success: { type: 'boolean', enum: [true] },
              data: {
                type: 'object',
                description: `Defined by @traceiq/${capability.split('+')[0] ?? capability}. Returned unchanged.`,
                additionalProperties: true,
              },
              meta: { $ref: '#/components/schemas/Meta' },
            },
          },
        },
      },
    },
  };

  for (const [status, statusCodes] of [...byStatus.entries()].sort((left, right) => left[0] - right[0])) {
    responses[String(status)] = {
      description: `Codes: ${statusCodes.sort().join(', ')}`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  return responses;
}
