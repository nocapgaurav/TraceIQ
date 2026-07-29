import type { DetectedFramework } from './types.js';

const EXPRESS_PACKAGE_NAME = 'express';

/**
 * Detects the framework from declared dependencies only.
 *
 * This is deliberately the shallowest possible detection. Establishing that a
 * repository *uses* Express — which routes exist, how routers compose — requires
 * resolved symbols and belongs to the Framework Extractor. The scanner answers
 * only whether Express is a declared dependency, which is enough for the
 * Project Host to know which extractor will eventually be needed.
 *
 * A repository that vendors Express without declaring it, or declares it while
 * using something else, is reported on the declaration. That is the limit of
 * what can be known without parsing.
 */
export function detectFramework(dependencyNames: readonly string[]): DetectedFramework {
  return dependencyNames.includes(EXPRESS_PACKAGE_NAME) ? 'express' : 'unknown';
}
