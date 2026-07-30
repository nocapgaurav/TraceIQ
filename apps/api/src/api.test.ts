import { describe, expect, it } from 'vitest';

import { ENDPOINTS, findEndpoint, methodsFor } from './endpoints.js';
import { ApiError, ERROR_CODES, HTTP_STATUS } from './errors.js';
import { openApiDocument } from './openapi.js';
import { API_VERSION, failure, success } from './respond.js';

const meta = { endpoint: '/x', capability: 'explorer', graphApiCalls: 3 };

describe('the endpoint table', () => {
  it('holds every endpoint the milestone specifies', () => {
    const paths = ENDPOINTS.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.documentedPath}`);

    expect(paths).toEqual([
      'GET /ping',
      'GET /version',
      'POST /scan',
      'GET /overview',
      'GET /architecture',
      'GET /packages',
      'GET /packages/{name}',
      'GET /files/{path}',
      'GET /symbol/{id}',
      'GET /impact/{id}',
      'GET /routes',
      'GET /route',
      'GET /health',
      'GET /search',
      'GET /dependencies/{id}',
      'GET /cycles',
      'GET /hotspots',
    ]);
  });

  it('finds an endpoint by method and documented path', () => {
    expect(findEndpoint('get', '/overview')?.operationId).toBe('overview');
    expect(findEndpoint('post', '/overview')).toBeUndefined();
  });

  it('reports the methods a path allows', () => {
    expect(methodsFor('/scan')).toEqual(['POST']);
    expect(methodsFor('/overview')).toEqual(['GET']);
  });

  it('gives every endpoint a unique operation id', () => {
    const ids = ENDPOINTS.map((endpoint) => endpoint.operationId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every endpoint a summary and a capability', () => {
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.summary.length).toBeGreaterThan(10);
      expect(endpoint.summary.endsWith('.')).toBe(true);
      expect(endpoint.capability.length).toBeGreaterThan(0);
    }
  });

  it('uses a wildcard for every parameter that can contain a slash', () => {
    for (const endpoint of ENDPOINTS) {
      const hasPathParameter = endpoint.parameters.some((parameter) => parameter.location === 'path');

      expect(endpoint.path.includes('*')).toBe(hasPathParameter);
    }
  });

  it('documents a wildcard path in OpenAPI brace form', () => {
    for (const endpoint of ENDPOINTS.filter((entry) => entry.path.includes('*'))) {
      expect(endpoint.documentedPath).toMatch(/\{[a-z]+\}$/);
      expect(endpoint.documentedPath).not.toContain('*');
    }
  });

  it('declares a parameter for every one its path names', () => {
    for (const endpoint of ENDPOINTS) {
      for (const name of [...endpoint.documentedPath.matchAll(/\{([a-z]+)\}/g)].map((match) => match[1])) {
        expect(endpoint.parameters.map((parameter) => parameter.name)).toContain(name);
      }
    }
  });

  it('gives every parameter a description and an example', () => {
    for (const endpoint of ENDPOINTS) {
      for (const parameter of endpoint.parameters) {
        expect(parameter.description.length).toBeGreaterThan(10);
        expect(parameter.example.length).toBeGreaterThan(0);
      }
    }
  });

  it('tells a client to percent-encode the # in a declaration identifier', () => {
    for (const operation of ['getSymbol', 'getImpact']) {
      const endpoint = ENDPOINTS.find((entry) => entry.operationId === operation);
      const parameter = endpoint?.parameters.find((entry) => entry.name === 'id');

      expect(parameter?.description).toContain('%23');
      expect(parameter?.example).toContain('%23');
    }
  });

  it('answers ping and version without a graph', () => {
    for (const operation of ['ping', 'version']) {
      expect(ENDPOINTS.find((endpoint) => endpoint.operationId === operation)?.errors).toEqual([]);
    }
  });
});

describe('errors', () => {
  it('maps every code to a status', () => {
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('separates a client mistake from a missing thing from a missing graph', () => {
    expect(HTTP_STATUS['missing-parameter']).toBe(400);
    expect(HTTP_STATUS['invalid-identifier']).toBe(400);
    expect(HTTP_STATUS['unknown-identifier']).toBe(404);
    expect(HTTP_STATUS['method-not-allowed']).toBe(405);
    expect(HTTP_STATUS['repository-not-scanned']).toBe(409);
    expect(HTTP_STATUS['invalid-repository']).toBe(422);
  });

  it('carries a code, a detail and a hint', () => {
    const error = new ApiError('unknown-identifier', "nothing named 'x'", 'use search');

    expect(error.status).toBe(404);
    expect(error.code).toBe('unknown-identifier');
    expect(error.hint).toBe('use search');
  });

  it('only declares errors an endpoint can actually produce', () => {
    for (const endpoint of ENDPOINTS) {
      for (const code of endpoint.errors) {
        expect(ERROR_CODES).toContain(code);
      }
    }
  });
});

describe('the response envelope', () => {
  it('wraps data with success and meta', () => {
    expect(success({ a: 1 }, meta)).toEqual({ success: true, data: { a: 1 }, meta });
  });

  it('returns the capability result unchanged', () => {
    const data = { nested: { list: [1, 2, 3] } };

    expect(success(data, meta).data).toBe(data);
  });

  it('wraps an error with success false and the same meta shape', () => {
    const body = failure(new ApiError('not-found', 'no endpoint', 'see openapi'), meta);

    expect(body).toEqual({
      success: false,
      error: { code: 'not-found', detail: 'no endpoint', hint: 'see openapi' },
      meta,
    });
  });

  it('carries no request identifier or timing in the body', () => {
    const serialised = JSON.stringify(success({ a: 1 }, meta));

    expect(serialised).not.toContain('requestId');
    expect(serialised).not.toContain('durationMs');
    expect(serialised).not.toContain('ms"');
  });
});

describe('the OpenAPI document', () => {
  const document = openApiDocument() as {
    openapi: string;
    info: { version: string };
    paths: Record<string, Record<string, { responses: Record<string, unknown>; parameters?: unknown[] }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('declares OpenAPI 3 and the API version', () => {
    expect(document.openapi).toBe('3.0.3');
    expect(document.info.version).toBe(API_VERSION);
  });

  it('documents every endpoint under its documented path', () => {
    for (const endpoint of ENDPOINTS) {
      expect(document.paths[endpoint.documentedPath]?.[endpoint.method]).toBeDefined();
    }
  });

  it('documents no path the router does not serve', () => {
    for (const path of Object.keys(document.paths)) {
      expect(ENDPOINTS.some((endpoint) => endpoint.documentedPath === path)).toBe(true);
    }
  });

  it('documents a success response and a 409 on every endpoint', () => {
    for (const endpoint of ENDPOINTS) {
      const operation = document.paths[endpoint.documentedPath]?.[endpoint.method];
      const statuses = Object.keys(operation?.responses ?? {});

      expect(statuses).toContain(endpoint.method === 'post' ? '201' : '200');
      expect(statuses).toContain('409');
    }
  });

  it('documents every error an endpoint declares', () => {
    for (const endpoint of ENDPOINTS) {
      const operation = document.paths[endpoint.documentedPath]?.[endpoint.method];
      const statuses = Object.keys(operation?.responses ?? {});

      for (const code of endpoint.errors) {
        expect(statuses).toContain(String(HTTP_STATUS[code]));
      }
    }
  });

  it('documents every parameter an endpoint declares', () => {
    for (const endpoint of ENDPOINTS.filter((entry) => entry.parameters.length > 0)) {
      const operation = document.paths[endpoint.documentedPath]?.[endpoint.method];

      expect(operation?.parameters).toHaveLength(endpoint.parameters.length);
    }
  });

  it('documents the request body of the only endpoint that takes one', () => {
    const withBody = ENDPOINTS.filter((endpoint) => endpoint.requestBody !== undefined);

    expect(withBody.map((endpoint) => endpoint.operationId)).toEqual(['scan']);
  });

  it('publishes the error schema with the closed code vocabulary', () => {
    const schema = document.components.schemas.Error as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };

    expect(schema.properties.error.properties.code.enum).toEqual([...ERROR_CODES]);
  });

  it('renders identically every time', () => {
    expect(JSON.stringify(openApiDocument())).toBe(JSON.stringify(openApiDocument()));
  });

  it('is valid JSON with no undefined values', () => {
    const serialised = JSON.stringify(openApiDocument());

    expect(serialised).not.toContain('undefined');
    expect(() => JSON.parse(serialised)).not.toThrow();
  });
});
