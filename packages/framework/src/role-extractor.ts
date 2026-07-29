import type { DeclarationIR, RepositoryIR } from '@traceiq/ir';
import type { NodeId, Role } from '@traceiq/types';

import type { RoleAnnotation } from './types.js';

interface RoleConvention {
  readonly role: Role;
  /** Name suffixes that indicate the role. */
  readonly suffixes: readonly string[];
  /** Path segments that indicate the role. */
  readonly directories: readonly string[];
}

/**
 * The conventions Express codebases actually use.
 *
 * Express provides no base class, decorator or interface to key on, so for these roles
 * a naming or directory convention is the only evidence available. Each annotation
 * records which one matched, so a consumer can judge it.
 *
 * Order is fixed, which is what makes the output deterministic when a declaration
 * matches more than one role.
 */
const CONVENTIONS: readonly RoleConvention[] = [
  { role: 'Controller', suffixes: ['Controller'], directories: ['controllers', 'controller'] },
  { role: 'Service', suffixes: ['Service'], directories: ['services', 'service'] },
  {
    role: 'Repository',
    suffixes: ['Repository', 'Repo'],
    directories: ['repositories', 'repository', 'repos'],
  },
  { role: 'Middleware', suffixes: ['Middleware'], directories: ['middleware', 'middlewares'] },
  { role: 'Model', suffixes: ['Model', 'Entity'], directories: ['models', 'entities'] },
];

const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;
const TEST_DIRECTORIES = ['__tests__', 'tests', 'test'];

/** Kinds that can play an architectural role. A member never does. */
const ROLE_BEARING_KINDS: readonly DeclarationIR['kind'][] = ['class', 'function', 'variable'];

export function extractRoles(input: {
  readonly ir: RepositoryIR;
  /** Declarations evidenced as middleware by their use in a route chain or `use` call. */
  readonly middlewareDeclarationIds: readonly NodeId[];
}): readonly RoleAnnotation[] {
  const pathByFileId = new Map(input.ir.files.map((file) => [file.id, file.path]));
  const middleware = new Set(input.middlewareDeclarationIds);
  const annotations: RoleAnnotation[] = [];

  for (const declaration of input.ir.declarations) {
    const filePath = pathByFileId.get(declaration.fileId);

    if (filePath === undefined) {
      continue;
    }

    // Declarations are walked in IR order and conventions in a fixed order, so the
    // output is deterministic without sorting.
    for (const annotation of rolesFor({ declaration, filePath, middleware })) {
      annotations.push(annotation);
    }
  }

  return annotations;
}

function rolesFor(input: {
  readonly declaration: DeclarationIR;
  readonly filePath: string;
  readonly middleware: ReadonlySet<NodeId>;
}): readonly RoleAnnotation[] {
  const { declaration, filePath } = input;
  const found: RoleAnnotation[] = [];
  const segments = filePath.split('/').slice(0, -1);
  const isTopLevel = declaration.containerChain.length === 1;

  // Strongest evidence first: actual use as middleware beats any naming convention.
  if (input.middleware.has(declaration.id)) {
    found.push(
      annotate(declaration, 'Middleware', 'used as middleware in an Express route chain or a use() call'),
    );
  }

  if (isTopLevel && ROLE_BEARING_KINDS.includes(declaration.kind)) {
    for (const convention of CONVENTIONS) {
      if (found.some((entry) => entry.role === convention.role)) {
        continue;
      }

      const suffix = convention.suffixes.find((value) => declaration.name.endsWith(value));

      if (suffix !== undefined) {
        found.push(
          annotate(declaration, convention.role, `its name ends with '${suffix}'`),
        );

        continue;
      }

      const directory = convention.directories.find((value) => segments.includes(value));

      if (directory !== undefined) {
        found.push(
          annotate(declaration, convention.role, `it is declared under a '${directory}/' directory`),
        );
      }
    }
  }

  if (isTopLevel && isTestFile(filePath, segments)) {
    found.push(annotate(declaration, 'Test', `'${filePath}' is a test file by name or directory`));
  }

  return found;
}

function isTestFile(filePath: string, segments: readonly string[]): boolean {
  return TEST_FILE.test(filePath) || segments.some((segment) => TEST_DIRECTORIES.includes(segment));
}

function annotate(declaration: DeclarationIR, role: Role, reason: string): RoleAnnotation {
  const location = declaration.locations[0];

  return {
    declarationId: declaration.id,
    role,
    // Never CERTAIN: a convention is evidence, not proof. This package has no
    // resolver, so it cannot do better than one plausible reading.
    confidence: 'INFERRED',
    provenance: {
      annotator: 'roles',
      fileId: declaration.fileId,
      evidence: `the ${declaration.kind} '${declaration.name}' is a ${role} because ${reason}`,
    },
    location: location ?? { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
  };
}
