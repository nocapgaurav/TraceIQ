import type { RepositoryIR } from '@traceiq/ir';
import type { ResolvedRepository } from '@traceiq/resolver';

import { extractClientCalls } from './client-call-extractor.js';
import { extractEnvironmentUsages } from './environment-extractor.js';
import { readExpressFacts } from './express-detection.js';
import { extractRoles } from './role-extractor.js';
import { extractRoutes } from './route-extractor.js';
import { NO_ANNOTATIONS, type FrameworkAnnotations } from './types.js';

/**
 * Reads Express conventions out of a repository's syntax and reports them as
 * annotations.
 *
 * A pure function of its inputs: no filesystem, no compiler, no database, no graph. It
 * writes nothing and modifies neither input.
 *
 * The IR supplies the syntax. The `ResolvedRepository` supplies one thing the IR cannot:
 * whether a specifier reading `'express'` actually resolved to the express package,
 * rather than to a local module of that name.
 *
 * Version 1 supports Express only, and no framework abstraction is introduced. There is
 * no plugin interface and no `Framework` type: one framework cannot show what a second
 * would need, and inventing the seam now would be guessing.
 *
 * Every annotation is `INFERRED`. Express offers no base class, decorator or interface
 * to key on, so every claim rests on a convention or on a syntactic chain that a later
 * reassignment could invalidate. Strength of evidence lives in the provenance text,
 * which is where an explanation belongs.
 */
export class FrameworkExtractor {
  extract(input: {
    readonly ir: RepositoryIR;
    readonly resolved: ResolvedRepository;
  }): FrameworkAnnotations {
    const express = readExpressFacts({ ir: input.ir, resolved: input.resolved });

    // Environment reads have nothing to do with Express, so they are extracted whether
    // or not it is present.
    const environmentVariables = extractEnvironmentUsages(input.ir);
    // Extracted whether or not a server framework is present, and deliberately: the half of a
    // repository that *calls* an API is usually not the half that serves one.
    const clientCalls = extractClientCalls(input.ir);

    if (!express.detected) {
      return {
        ...NO_ANNOTATIONS,
        roles: extractRoles({ ir: input.ir, middlewareDeclarationIds: [] }),
        environmentVariables,
        clientCalls,
      };
    }

    const { routes, middlewareDeclarationIds } = extractRoutes({ ir: input.ir, express });

    return {
      framework: 'express',
      roles: extractRoles({ ir: input.ir, middlewareDeclarationIds }),
      routes,
      environmentVariables,
      clientCalls,
    };
  }
}
