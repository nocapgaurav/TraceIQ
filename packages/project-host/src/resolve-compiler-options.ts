import path from 'node:path';

import type { RepositoryInventory } from '@traceiq/scanner';
import { ts } from 'ts-morph';

import { DEFAULT_COMPILER_OPTIONS, type CompilerOptions } from './compiler-options.js';
import {
  mergePathMappings,
  rebasePathMappings,
  workspacePathMappings,
  type PathMappings,
} from './workspace-paths.js';

/**
 * The compiler options one repository is analysed under, and where each came from.
 *
 * The provenance is not decoration. These options are the single largest determinant of
 * how much of a repository resolves, and when a scan comes back thin the first question
 * is what the compiler was actually configured with — a question the old behaviour could
 * not answer, because the options were whatever ts-morph made of a tsconfig nobody read.
 */
export interface ResolvedCompilerOptions {
  readonly options: Readonly<CompilerOptions>;
  /** Human-readable notes on what was merged and why, in the order decided. */
  readonly notes: readonly string[];
  /**
   * True when the inventory named a root tsconfig that could not be read or parsed.
   *
   * Reported rather than thrown, because this module decides options and does not own
   * the host's error type. The caller is expected to treat it as fatal: the scanner only
   * names a tsconfig it found, so one that will not parse means the repository would be
   * analysed under defaults while appearing to be configured — precisely the silent
   * quality loss this resolution exists to end.
   */
  readonly rootTsconfigUnreadable: boolean;
}

/**
 * A package's own tsconfig contributes `jsx`, `jsxImportSource`, `lib` and `paths`, and
 * nothing else.
 *
 * Deliberately only those that decide **what can be parsed or resolved** — never those
 * that decide what type checking *means*. Merging `strict` or `exactOptionalPropertyTypes`
 * across packages would silently analyse code under rules its authors did not choose;
 * merging `jsx` and `paths` only makes files readable that were previously unreadable.
 */

/**
 * Decides the compiler options for a repository.
 *
 * Four layers, later overriding earlier:
 *
 * 1. `DEFAULT_COMPILER_OPTIONS` — a working modern-Node baseline, so a program is never
 *    left with TypeScript's own defaults (`ES5`, classic module resolution, no `jsx`).
 * 2. The root tsconfig's options.
 * 3. Parse- and resolution-affecting options from each workspace package's tsconfig.
 * 4. Path mappings redirecting workspace packages to their sources.
 *
 * Layer 2 is frequently empty, and that is the case worth naming: a monorepo root
 * tsconfig is usually a *solution* file — `"files": []` plus `references` — which
 * declares no `compilerOptions` at all. Handing it to the compiler configures nothing,
 * so before this the entire repository was analysed under TypeScript's defaults while a
 * tsconfig sat in the root looking authoritative.
 */
export function resolveCompilerOptions(
  inventory: RepositoryInventory,
): ResolvedCompilerOptions {
  const notes: string[] = [];

  const fromRoot =
    inventory.tsconfigPath === null
      ? null
      : readTsconfigOptions(path.join(inventory.rootPath, inventory.tsconfigPath));

  if (inventory.tsconfigPath === null) {
    notes.push('no tsconfig.json at the repository root; using built-in defaults');
  } else if (fromRoot === null) {
    notes.push(`the tsconfig at ${inventory.tsconfigPath} could not be read`);
  } else if (!fromRoot.declaresOptions) {
    notes.push(
      `${inventory.tsconfigPath} declares no compilerOptions — a solution-style config; built-in defaults are in force instead`,
    );
  } else {
    notes.push(`compiler options read from ${inventory.tsconfigPath}`);
  }

  const fromPackages = collectPackageOptions(inventory, notes);

  const workspacePaths = workspacePathMappings({
    rootPath: inventory.rootPath,
    workspacePackages: inventory.workspacePackages,
  });

  if (inventory.workspacePackages.length > 0) {
    notes.push(
      `${inventory.workspacePackages.length} workspace package(s) redirected to source, so sibling imports resolve to declarations rather than to ignored build output`,
    );
  }

  // Workspace mappings come first: they are derived from packages the scan actually
  // found, whereas a tsconfig alias is a declaration that may name anything.
  const paths = mergePathMappings(workspacePaths, fromPackages.paths, fromRoot?.paths ?? {});

  const options: CompilerOptions = {
    ...DEFAULT_COMPILER_OPTIONS,
    ...(fromRoot?.options ?? {}),
    ...fromPackages.options,
  };

  if (Object.keys(paths).length > 0) {
    options.paths = paths;
    // Every substitution is absolute, so no anchor is needed and setting one would make
    // bare specifiers resolvable against the repository root. See `workspacePathMappings`.
    delete options.baseUrl;
  }

  applyJsxFallback(inventory, options, notes);
  // Whether the *repository* decided, which is not the same as whether `options` has a value: the
  // defaults above always supply one. Conflating the two silently disabled JavaScript analysis for
  // every repository whose tsconfig did not mention `allowJs` — which is all of them, since a
  // JavaScript repository usually has no tsconfig at all.
  applyJavaScriptSupport(inventory, options, notes, {
    declaredByRepository:
      fromRoot?.options.allowJs !== undefined || fromPackages.options.allowJs !== undefined,
  });

  return {
    options,
    notes,
    rootTsconfigUnreadable: inventory.tsconfigPath !== null && fromRoot === null,
  };
}

/**
 * Reads one tsconfig's options, with its `paths` rebased to absolute.
 *
 * `extends` chains are followed, because TypeScript follows them and a package whose
 * options all live in a shared base would otherwise appear to declare nothing. Returns
 * `null` when the file cannot be read or parsed — a broken tsconfig in one package must
 * not stop the repository being analysed.
 */
function readTsconfigOptions(absolutePath: string): TsconfigOptions | null {
  const read = ts.readConfigFile(absolutePath, ts.sys.readFile);

  if (read.error !== undefined || read.config === undefined) {
    return null;
  }

  const directory = path.dirname(absolutePath);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, directory, undefined, absolutePath);

  // `parseJsonConfigFileContent` reports unknown keys and bad values in `errors` but
  // still returns everything it understood. Options that parsed are worth having, so
  // errors are not treated as fatal.
  const options = { ...parsed.options };

  // Stripped: `configFilePath` is injected by the parser and names a file this program
  // is not built from, and the rest describe how a project *emits*, which a merged
  // analysis program never does. Carrying the emit options over makes the compiler
  // complain about output collisions between packages that each declare their own.
  for (const key of [
    'configFilePath',
    'outDir',
    'rootDir',
    'declarationDir',
    'tsBuildInfoFile',
    'composite',
    'incremental',
  ]) {
    delete options[key];
  }

  const paths =
    parsed.options.paths === undefined
      ? {}
      : rebasePathMappings({
          paths: parsed.options.paths as PathMappings,
          baseDirectory: parsed.options.baseUrl ?? directory,
        });

  delete options.paths;
  delete options.baseUrl;

  return { options, paths, declaresOptions: declaresCompilerOptions(read.config) };
}

interface TsconfigOptions {
  readonly options: CompilerOptions;
  readonly paths: PathMappings;
  /**
   * Whether the file itself declared any `compilerOptions`.
   *
   * Asked of the raw JSON rather than of the parsed result, because the parser fills in
   * defaults and a solution-style config would otherwise look configured.
   */
  readonly declaresOptions: boolean;
}

function declaresCompilerOptions(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const declared = (config as { compilerOptions?: unknown }).compilerOptions;

  return (
    typeof declared === 'object' && declared !== null && Object.keys(declared).length > 0
  );
}

/** Gathers the narrow set of options packages are allowed to contribute. */
function collectPackageOptions(
  inventory: RepositoryInventory,
  notes: string[],
): { options: CompilerOptions; paths: PathMappings } {
  const options: CompilerOptions = {};
  const tables: PathMappings[] = [];
  const libs = new Set<string>();
  let aliasCount = 0;

  for (const workspacePackage of inventory.workspacePackages) {
    if (workspacePackage.tsconfigPath === null) {
      continue;
    }

    const read = readTsconfigOptions(path.join(inventory.rootPath, workspacePackage.tsconfigPath));

    if (read === null) {
      notes.push(`${workspacePackage.tsconfigPath} could not be read and was skipped`);
      continue;
    }

    // First declaration wins. Packages are sorted by name, so this is stable rather
    // than dependent on walk order.
    if (options.jsx === undefined && read.options.jsx !== undefined) {
      options.jsx = read.options.jsx;
    }

    if (options.jsxImportSource === undefined && read.options.jsxImportSource !== undefined) {
      options.jsxImportSource = read.options.jsxImportSource;
    }

    for (const lib of read.options.lib ?? []) {
      libs.add(lib);
    }

    if (Object.keys(read.paths).length > 0) {
      aliasCount += Object.keys(read.paths).length;
      tables.push(read.paths);
    }
  }

  if (libs.size > 0) {
    // A union: a repository holding both a DOM app and a Node service needs both, and
    // omitting either makes half its globals unresolvable.
    options.lib = [...libs].sort();
  }

  if (aliasCount > 0) {
    notes.push(`${aliasCount} path alias pattern(s) merged from workspace package tsconfigs`);
  }

  return { options, paths: mergePathMappings(...tables) };
}

/**
 * Ensures `.tsx` sources can be parsed at all.
 *
 * Without a `jsx` option the compiler cannot parse JSX syntax, so every `.tsx` file in
 * the repository produces a syntax error and contributes nothing. `preserve` is the
 * conservative choice: it makes the syntax readable without committing the program to a
 * JSX runtime's types, which is what the stricter modes require.
 */
/**
 * Lets the compiler read the repository's JavaScript.
 *
 * Without `allowJs` a `.js` file in the program is silently ignored: no declarations, no imports, no
 * calls. Turning it on is what makes JavaScript a first-class analysed language rather than a set of
 * files the scan can see but not read.
 *
 * `checkJs` is deliberately **not** set. It makes the compiler *type-check* JavaScript and report
 * diagnostics, which TraceIQ never reads — it would cost time on every scan and change nothing about
 * the facts extracted. Inference still runs without it, so `svc.run()` in a `.js` file still binds
 * through the checker exactly as it does in TypeScript.
 *
 * A repository's own `allowJs: false` is respected: its authors have said the compiler should not
 * read those files, and overriding that would analyse a build output directory the repository
 * deliberately excludes.
 *
 * **`declaredByRepository` is the whole correctness of this function.** It used to test
 * `options.allowJs !== undefined`, but `DEFAULT_COMPILER_OPTIONS` sets `allowJs: false`, so the value
 * was *always* defined by the time this ran and this function always returned immediately. The effect
 * was measurable and large: express's 141 CommonJS files yielded declarations — those come from the
 * syntax tree — while every one of its 314 relative `require` calls reported `module-not-resolved`,
 * because module resolution will not consider a `.js` extension without `allowJs`. A JavaScript
 * repository therefore had no internal import graph at all, and nothing said so.
 */
function applyJavaScriptSupport(
  inventory: RepositoryInventory,
  options: CompilerOptions,
  notes: string[],
  input: { readonly declaredByRepository: boolean },
): void {
  if (input.declaredByRepository) {
    return;
  }

  const javaScriptFiles = inventory.sourceFiles.filter((file) =>
    /\.(?:js|jsx|mjs|cjs)$/.test(file),
  ).length;

  if (javaScriptFiles === 0) {
    return;
  }

  options.allowJs = true;
  notes.push(
    `${javaScriptFiles} JavaScript source(s) present and no tsconfig set allowJs; enabling it so the compiler reads them`,
  );
}

function applyJsxFallback(
  inventory: RepositoryInventory,
  options: CompilerOptions,
  notes: string[],
): void {
  if (options.jsx !== undefined) {
    return;
  }

  if (!inventory.sourceFiles.some((file) => file.endsWith('.tsx'))) {
    return;
  }

  options.jsx = ts.JsxEmit.Preserve;
  notes.push('.tsx sources present but no tsconfig declared jsx; defaulting to preserve so they parse');
}
