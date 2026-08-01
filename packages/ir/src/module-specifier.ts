import type { ExportDeclaration, ImportDeclaration, SourceFile } from 'ts-morph';

/**
 * A module specifier's text, or `null` when it is not a string literal.
 *
 * **ts-morph throws rather than returning undefined here**, with `Expected the module specifier to be a
 * string literal`, and the throw escapes the whole analyser. Measured against React: 7,280 files scanned
 * to `universal` depth with **zero declarations**, because one import somewhere in the tree does not have
 * a literal specifier. One unreadable specifier should cost that import and nothing else.
 *
 * A non-literal specifier is genuinely unaddressable — there is no module name to record, so nothing is
 * recorded, which is the same rule the declaration extractor applies to a computed member name.
 */
export function moduleSpecifierOf(declaration: ImportDeclaration | ExportDeclaration): string | null {
  try {
    return declaration.getModuleSpecifierValue() ?? null;
  } catch {
    return null;
  }
}

/**
 * The file a specifier resolves to, or `undefined`.
 *
 * Guarded for the same reason and by the same evidence: `getModuleSpecifierSourceFile` reads the
 * specifier first, so it throws wherever `getModuleSpecifierValue` would. This was the site that
 * actually cost React its analysis — the IR had already produced 30,254 declarations and 10,643 imports
 * before the Resolver hit it.
 */
export function moduleSourceFileOf(
  declaration: ImportDeclaration | ExportDeclaration,
): SourceFile | undefined {
  try {
    return declaration.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}
