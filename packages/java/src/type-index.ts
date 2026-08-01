import type { NodeId } from '@traceiq/types';

/**
 * Maps Java type names onto the repository's declarations.
 *
 * **Java's own rule is a classpath lookup, and there is no classpath here.** What *can* be established
 * from the source alone is where each type is declared and what each file can see, and that covers the
 * cases a reader cares about:
 *
 * - a fully-qualified name — `com.example.svc.UserService` — resolves to the declaration of that name
 * - a simple name resolves to a single-type import, then to the file's own package, then to a
 *   wildcard-imported package
 *
 * Anything else is left unbound with a reason. In particular a simple name matched in *two*
 * wildcard-imported packages is reported ambiguous rather than resolved to whichever was seen first:
 * javac would reject that program, and picking one would invent a fact the source does not contain.
 */
export interface JavaTypeIndex {
  /** Every declaration of a fully-qualified type name. Several only for a genuinely duplicated name. */
  byQualifiedName(name: string): readonly TypeEntry[];
  /** Every declaration of a simple type name, across all packages. */
  bySimpleName(name: string): readonly TypeEntry[];
  /** The declarations a package holds, keyed by simple name. */
  inPackage(packageName: string, simpleName: string): readonly TypeEntry[];
}

export interface TypeEntry {
  readonly declarationId: NodeId;
  readonly filePath: string;
  /** `''` for the default package. */
  readonly packageName: string;
  readonly simpleName: string;
  /** `packageName.simpleName`, or just the simple name in the default package. */
  readonly qualifiedName: string;
  /** Members declared directly on this type, by simple name. Several for an overload set. */
  readonly members: ReadonlyMap<string, readonly NodeId[]>;
}

export interface TypeDeclarationInput {
  readonly declarationId: NodeId;
  readonly filePath: string;
  readonly packageName: string | null;
  /** The container chain within the file: `Outer` or `Outer.Inner`. */
  readonly chain: readonly string[];
  readonly members: ReadonlyMap<string, readonly NodeId[]>;
}

export function buildTypeIndex(types: readonly TypeDeclarationInput[]): JavaTypeIndex {
  const byQualified = new Map<string, TypeEntry[]>();
  const bySimple = new Map<string, TypeEntry[]>();
  const byPackage = new Map<string, TypeEntry[]>();

  for (const type of types) {
    const packageName = type.packageName ?? '';
    // A nested type is addressed `Outer.Inner` in Java source and `Outer$Inner` in a class file. The
    // source form is what an import or a reference writes, so that is the form indexed.
    const simpleName = type.chain.join('.');
    const qualifiedName = packageName === '' ? simpleName : `${packageName}.${simpleName}`;

    const entry: TypeEntry = {
      declarationId: type.declarationId,
      filePath: type.filePath,
      packageName,
      simpleName,
      qualifiedName,
      members: type.members,
    };

    append(byQualified, qualifiedName, entry);
    append(bySimple, simpleName, entry);
    append(byPackage, `${packageName}#${simpleName}`, entry);

    // A nested type is also reachable by its own last segment: `Inner` inside `Outer`, and from
    // elsewhere after `import com.example.Outer.Inner`.
    const last = type.chain.at(-1);

    if (last !== undefined && last !== simpleName) {
      append(bySimple, last, entry);
      append(byPackage, `${packageName}#${last}`, entry);
    }
  }

  return {
    byQualifiedName: (name) => byQualified.get(name) ?? [],
    bySimpleName: (name) => bySimple.get(name) ?? [],
    inPackage: (packageName, simpleName) => byPackage.get(`${packageName}#${simpleName}`) ?? [],
  };
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);

  if (bucket === undefined) {
    map.set(key, [value]);
  } else {
    bucket.push(value);
  }
}

/**
 * What one file can see, which is what makes a simple name resolvable.
 *
 * Built per compilation unit from its own package and its imports, because Java's visibility is
 * per-file: two files in the same repository can use the same simple name for different types, and a
 * resolver that ignored the imports would bind both to whichever it indexed first.
 */
export interface FileScope {
  readonly filePath: string;
  /** `''` for the default package. */
  readonly packageName: string;
  /** Simple name → fully-qualified name, from single-type imports. */
  readonly singleTypeImports: ReadonlyMap<string, string>;
  /** Packages a wildcard import made available, in source order. */
  readonly wildcardPackages: readonly string[];
  /** Fully-qualified type names whose static members a `import static X.*` made available. */
  readonly staticWildcardTypes: readonly string[];
  /** Simple member name → fully-qualified owning type, from `import static X.member`. */
  readonly staticImports: ReadonlyMap<string, string>;
}

export function buildFileScope(input: {
  readonly filePath: string;
  readonly packageName: string | null;
  /** Import specifiers exactly as written, and whether each was a wildcard or `static`. */
  readonly imports: readonly {
    readonly specifier: string;
    readonly isWildcard: boolean;
    readonly isStatic: boolean;
  }[];
}): FileScope {
  const singleTypeImports = new Map<string, string>();
  const wildcardPackages: string[] = [];
  const staticWildcardTypes: string[] = [];
  const staticImports = new Map<string, string>();

  for (const statement of input.imports) {
    const segments = statement.specifier.split('.').filter((segment) => segment.length > 0);
    const last = segments.at(-1);

    if (statement.isWildcard) {
      // `import java.util.*` makes a package's types visible; `import static Map.*` makes a type's
      // static members visible. The specifier is the package in one case and the type in the other,
      // and conflating them would look for `entry` among packages.
      (statement.isStatic ? staticWildcardTypes : wildcardPackages).push(statement.specifier);
      continue;
    }

    if (last === undefined) {
      continue;
    }

    if (statement.isStatic) {
      staticImports.set(last, segments.slice(0, -1).join('.'));
      continue;
    }

    singleTypeImports.set(last, statement.specifier);
  }

  return {
    filePath: input.filePath,
    packageName: input.packageName ?? '',
    singleTypeImports,
    wildcardPackages,
    staticWildcardTypes,
    staticImports,
  };
}

/** What resolving a simple type name produced. */
export type TypeLookup =
  | { readonly outcome: 'resolved'; readonly entry: TypeEntry; readonly evidence: string }
  | { readonly outcome: 'ambiguous'; readonly entries: readonly TypeEntry[]; readonly evidence: string }
  | { readonly outcome: 'unresolved'; readonly reason: 'not-in-repository' };

/**
 * Resolves a type name as the file that wrote it would see it.
 *
 * The order is Java's own, and each step is a rule a reader could check:
 *
 * 1. a fully-qualified name resolves directly;
 * 2. a single-type import wins over everything, which is exactly why it exists;
 * 3. the file's own package needs no import;
 * 4. a wildcard-imported package, and only if exactly one of them holds the name.
 *
 * `java.lang` is deliberately *not* consulted: it is not in the repository, so it cannot resolve here,
 * and the caller classifies it as a standard-library external instead.
 */
export function lookupType(input: {
  readonly name: string;
  readonly scope: FileScope;
  readonly index: JavaTypeIndex;
}): TypeLookup {
  const { name, scope, index } = input;

  if (name.includes('.')) {
    const direct = index.byQualifiedName(name);

    if (direct.length === 1) {
      return {
        outcome: 'resolved',
        entry: direct[0] as TypeEntry,
        evidence: `'${name}' is a fully-qualified name declared in this repository`,
      };
    }

    if (direct.length > 1) {
      return {
        outcome: 'ambiguous',
        entries: direct,
        evidence: `'${name}' is declared ${direct.length} times in this repository`,
      };
    }
  }

  const imported = scope.singleTypeImports.get(name);

  if (imported !== undefined) {
    const byImport = index.byQualifiedName(imported);

    if (byImport.length === 1) {
      return {
        outcome: 'resolved',
        entry: byImport[0] as TypeEntry,
        evidence: `'${name}' is imported from '${imported}', which this repository declares`,
      };
    }
  }

  const ownPackage = index.inPackage(scope.packageName, name);

  if (ownPackage.length === 1) {
    return {
      outcome: 'resolved',
      entry: ownPackage[0] as TypeEntry,
      evidence:
        scope.packageName === ''
          ? `'${name}' is declared in the same default package as this file`
          : `'${name}' is declared in this file's own package '${scope.packageName}'`,
    };
  }

  const fromWildcards = scope.wildcardPackages.flatMap((packageName) =>
    index.inPackage(packageName, name),
  );

  if (fromWildcards.length === 1) {
    const entry = fromWildcards[0] as TypeEntry;

    return {
      outcome: 'resolved',
      entry,
      evidence: `'${name}' is the only match among this file's wildcard imports, in '${entry.packageName}'`,
    };
  }

  if (fromWildcards.length > 1) {
    // javac rejects this program. Choosing one would invent a fact, so every candidate is kept and
    // the graph records them as alternatives.
    return {
      outcome: 'ambiguous',
      entries: fromWildcards,
      evidence: `'${name}' matches ${fromWildcards.length} wildcard-imported packages, which the source does not disambiguate`,
    };
  }

  return { outcome: 'unresolved', reason: 'not-in-repository' };
}
