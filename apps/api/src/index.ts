export { createApp, type AppOptions, type LogEntry, type TraceIqApp } from './app.js';
export {
  parseChatRequest,
  wireAnswer,
  wireGrounding,
  type ChatRequest,
  type WireAnswer,
  type WireCitation,
  type WireGrounding,
  type WireOmission,
} from './chat.js';
export { openEventStream, type EventSink } from './sse.js';
export { ENDPOINTS, answererFor, findEndpoint, methodsFor, type Endpoint, type ParameterSpec, type RequestContext } from './endpoints.js';
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

// The chat endpoints contain zero AI logic: they validate a body, call RepositoryAnswerer and project its
// result onto the wire. The model arrives by constructor injection from the composition root — there is no
// registry here and no vendor named anywhere under src/.
//
// The API contains zero repository intelligence. Each endpoint validates its parameters, calls one
// capability and returns that capability's result unchanged. It imports only @traceiq/pipeline and the
// read capabilities — never the scanner, project host, IR, resolver, framework extractor, graph
// builder, graph store, SQLite or ts-morph.
