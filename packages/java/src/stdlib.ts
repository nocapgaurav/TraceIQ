/**
 * Java's standard-library package prefixes, and the `java.lang` types that need no import.
 *
 * **Facts about the platform, not heuristics.** `java.*` and `javax.*` are reserved by the JDK, and
 * `jdk.*` and `sun.*` ship with it. Without this, every `import java.util.List` would be reported as a
 * missing dependency, which would bury the imports that really are one — and `String` in a signature
 * would look like an unresolved reference in every file in the repository.
 *
 * `javax` is deliberately included even though Jakarta EE moved to `jakarta.*`: the `javax.*` packages
 * that remain in the JDK — `javax.crypto`, `javax.net`, `javax.sql` — are standard library, while
 * `jakarta.*` is a real Maven dependency and is correctly *not* listed here.
 */
const STANDARD_PREFIXES: readonly string[] = ['java.', 'javax.', 'jdk.', 'sun.', 'com.sun.'];

/** True when a dotted name lies in a package the JDK ships. */
export function isJavaStandardLibrary(dottedName: string): boolean {
  return STANDARD_PREFIXES.some((prefix) => dottedName.startsWith(prefix));
}

/**
 * The package part of a dotted type name, which is what an external node is named after.
 *
 * `java.util.List` becomes `java.util`; `org.apache.commons.lang3.StringUtils` becomes
 * `org.apache.commons.lang3`. A package rather than a type, because that is the unit a dependency
 * actually is — one external node per package keeps the graph readable, where one per type would add
 * hundreds of nodes that all mean "this repository uses commons-lang3".
 *
 * A segment beginning with an upper-case letter is treated as the type: Java's own convention, and the
 * only signal available without a classpath. `java.util.Map.Entry` therefore yields `java.util`, which
 * is right.
 */
export function javaPackageOf(dottedName: string): string {
  const segments = dottedName.split('.').filter((segment) => segment.length > 0);
  const packageSegments: string[] = [];

  for (const segment of segments) {
    const first = segment[0];

    if (first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()) {
      break;
    }

    packageSegments.push(segment);
  }

  // An all-lower-case name with no type segment is already a package: `import java.util.*`.
  return packageSegments.length === 0 ? dottedName : packageSegments.join('.');
}

/**
 * The `java.lang` types available without an import.
 *
 * Only the ones a repository's source realistically names. The list is used to answer "is this bare
 * type name a platform type or a type parameter?", and an omission errs toward `null` — reporting
 * nothing rather than fabricating a dependency, which is the safer direction.
 */
const JAVA_LANG_TYPES: ReadonlySet<string> = new Set([
  'Appendable', 'AutoCloseable', 'Boolean', 'Byte', 'Character', 'CharSequence', 'Class',
  'ClassLoader', 'Cloneable', 'Comparable', 'Double', 'Enum', 'Error', 'Exception', 'Float',
  'FunctionalInterface', 'Integer', 'Iterable', 'Long', 'Math', 'Number', 'Object', 'Override',
  'Package', 'Process', 'ProcessBuilder', 'Readable', 'Record', 'Runnable', 'Runtime',
  'RuntimeException', 'SafeVarargs', 'Short', 'StackTraceElement', 'String', 'StringBuilder',
  'StringBuffer', 'SuppressWarnings', 'System', 'Thread', 'ThreadLocal', 'Throwable', 'Void',
  'Deprecated', 'IllegalArgumentException', 'IllegalStateException', 'IndexOutOfBoundsException',
  'InterruptedException', 'NullPointerException', 'NumberFormatException', 'UnsupportedOperationException',
  'ArithmeticException', 'ArrayIndexOutOfBoundsException', 'ClassCastException', 'CloneNotSupportedException',
  'StringIndexOutOfBoundsException', 'Iterable', 'ThreadGroup',
]);

/** True when a bare type name is one `java.lang` provides implicitly. */
export function isJavaLangType(simpleName: string): boolean {
  return JAVA_LANG_TYPES.has(simpleName);
}
