import type { RepositoryIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';

import type { EnvironmentVariableAnnotation } from './types.js';

const PROCESS = 'process';
const ENV = 'env';

/**
 * Extracts reads of `process.env`.
 *
 * Read entirely from the IR's member-access chains: a chain rooted at `process` whose
 * first segment is `env` and which names a variable. `process.env['NAME']` reads the
 * same as `process.env.NAME`, because the IR already folded a string-literal element
 * access into the path.
 *
 * Every usage is `INFERRED`, never `CERTAIN`. The syntax is unambiguous but this
 * package has no resolver, so it cannot prove that `process` is the Node global rather
 * than something local. The evidence records whether anything in the file declares or
 * imports that name, which is the signal a consumer can act on.
 */
export function extractEnvironmentUsages(ir: RepositoryIR): readonly EnvironmentVariableAnnotation[] {
  const shadowingFiles = filesDeclaringProcess(ir);
  const usages: EnvironmentVariableAnnotation[] = [];

  for (const access of ir.memberAccesses) {
    if (access.rootName !== PROCESS || access.path[0] !== ENV) {
      continue;
    }

    const name = access.path[1];

    // `process.env` on its own names no variable — it is a whole-object read, most
    // often a spread or a destructure the IR cannot see into.
    if (name === undefined) {
      continue;
    }

    const shadowed = shadowingFiles.has(access.fileId);

    usages.push({
      name,
      usedInDeclarationId: access.enclosingDeclarationId,
      confidence: 'INFERRED',
      provenance: {
        annotator: 'environment',
        fileId: access.fileId,
        evidence: shadowed
          ? `'${access.text}' reads an environment variable, but this file also declares or imports something named 'process', so the root may be shadowed`
          : `'${access.text}' reads an environment variable, and nothing in this file declares or imports the name 'process'`,
      },
      location: access.location,
    });
  }

  return usages;
}

/**
 * Files where the name `process` is declared or imported, so a chain rooted at it may
 * not be the Node global.
 */
function filesDeclaringProcess(ir: RepositoryIR): ReadonlySet<NodeId> {
  const files = new Set<NodeId>();

  for (const declaration of ir.declarations) {
    if (declaration.containerChain.length === 1 && declaration.name === PROCESS) {
      files.add(declaration.fileId);
    }
  }

  for (const statement of ir.imports) {
    if (statement.bindings.some((binding) => binding.localName === PROCESS)) {
      files.add(statement.fileId);
    }
  }

  return files;
}
