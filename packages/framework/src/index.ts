export { extractClientCalls } from './client-call-extractor.js';
export { FrameworkExtractor } from './framework-extractor.js';
export {
  ANNOTATORS,
  HTTP_METHODS,
  NO_ANNOTATIONS,
  type AnnotationProvenance,
  type AnnotatorName,
  type ClientCallAnnotation,
  type EnvironmentVariableAnnotation,
  type FrameworkAnnotations,
  type HttpMethod,
  type RoleAnnotation,
  type RouteAnnotation,
  type RouteHandlerAnnotation,
} from './types.js';

// No ts-morph value or type is exported, and none is imported: this package reads the
// IR only. A consumer receives plain data.
