export { createApp, type AppOptions, type LogEntry, type TraceIqApp } from './app.js';
export { ENDPOINTS, findEndpoint, methodsFor, type Endpoint, type ParameterSpec } from './endpoints.js';
export { ApiError, ERROR_CODES, HTTP_STATUS, type ErrorCode } from './errors.js';
export { Capabilities, GraphHolder } from './graph-holder.js';
export { openApiDocument } from './openapi.js';
export {
  API_VERSION,
  REQUEST_ID_HEADER,
  RESPONSE_TIME_HEADER,
  VERSION_HEADER,
  failure,
  success,
  type ErrorBody,
  type ResponseMeta,
  type SuccessBody,
} from './respond.js';
export { startServer, type StartedServer } from './server.js';

// The API contains zero repository intelligence. Each endpoint validates its parameters, calls one
// capability and returns that capability's result unchanged. It imports only @traceiq/pipeline and the
// read capabilities — never the scanner, project host, IR, resolver, framework extractor, graph
// builder, graph store, SQLite or ts-morph.
