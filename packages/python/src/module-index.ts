/**
 * Maps Python dotted module names onto the repository's files, and back.
 *
 * Python's import system is resolved at runtime against `sys.path`, which a static analyser cannot
 * know: a path entry added by a launcher, an installed distribution shadowing a local package, a
 * namespace package assembled from several roots. What *can* be established from the file tree is
 * the common case, and this establishes exactly that and no more.
 *
 * Two roots are recognised, because they cover nearly every layout in practice:
 *
 * - the region's own directory — `app/main.py` is the module `app.main`
 * - a `src/` directory beneath it — `src/app/main.py` is *also* `app.main`, which is the whole point
 *   of the src layout
 *
 * A directory is a package when it holds `__init__.py`; `__init__.py` itself is the package module,
 * so `app/__init__.py` is `app` rather than `app.__init__`. A directory without one is still indexed,
 * because implicit namespace packages are legal since Python 3.3 and refusing them would silently
 * lose modules.
 */
export interface ModuleIndex {
  /** The dotted name of a file, or `null` when it lies under no recognised root. */
  moduleNameOf(repoRelativePath: string): string | null;
  /** The file a dotted name refers to, or `null` when the repository holds no such module. */
  fileFor(moduleName: string): string | null;
  /** Whether a dotted name is a package — a directory with `__init__.py`. */
  isPackage(moduleName: string): boolean;
}

const PYTHON_FILE = /\.pyi?$/;

export function buildModuleIndex(pythonFiles: readonly string[]): ModuleIndex {
  const roots = discoverRoots(pythonFiles);
  const byModule = new Map<string, string>();
  const byFile = new Map<string, string>();
  const packages = new Set<string>();

  for (const file of pythonFiles) {
    const moduleName = nameOf(file, roots);

    if (moduleName === null) {
      continue;
    }

    byFile.set(file, moduleName);

    // A `.py` wins over a `.pyi` stub of the same module: the stub describes the implementation,
    // and the implementation is what the repository actually runs.
    const existing = byModule.get(moduleName);

    if (existing === undefined || (existing.endsWith('.pyi') && file.endsWith('.py'))) {
      byModule.set(moduleName, file);
    }

    if (file.endsWith('__init__.py')) {
      packages.add(moduleName);
    }
  }

  return {
    moduleNameOf: (file) => byFile.get(file) ?? null,
    fileFor: (moduleName) => byModule.get(moduleName) ?? null,
    isPackage: (moduleName) => packages.has(moduleName),
  };
}

/**
 * Import roots, longest first so the most specific wins.
 *
 * `''` — the repository root — is always a root, which is what makes a flat `app/main.py` layout
 * work. Every `src` directory is also a root, so `services/api/src/app/main.py` is `app.main` as its
 * own package intends rather than `services.api.src.app.main`, which no import would ever spell.
 */
function discoverRoots(pythonFiles: readonly string[]): readonly string[] {
  const roots = new Set<string>(['']);

  for (const file of pythonFiles) {
    const segments = file.split('/');

    for (let index = 0; index < segments.length - 1; index += 1) {
      if (segments[index] === 'src') {
        roots.add(segments.slice(0, index + 1).join('/'));
      }
    }
  }

  return [...roots].sort((a, b) => b.length - a.length);
}

function nameOf(file: string, roots: readonly string[]): string | null {
  if (!PYTHON_FILE.test(file)) {
    return null;
  }

  for (const root of roots) {
    if (root !== '' && !file.startsWith(`${root}/`)) {
      continue;
    }

    const relative = root === '' ? file : file.slice(root.length + 1);
    const withoutExtension = relative.replace(PYTHON_FILE, '');
    const segments = withoutExtension.split('/');

    // `pkg/__init__.py` is the module `pkg`, not `pkg.__init__`.
    if (segments.at(-1) === '__init__') {
      segments.pop();
    }

    return segments.length === 0 ? null : segments.join('.');
  }

  return null;
}

/**
 * Resolves a relative import to an absolute dotted name.
 *
 * `from . import x` inside `a.b.c` means `a.b`; `from ..d import y` means `a.d`. The leading dots
 * count how far up from the *containing package* to walk — one dot is the package itself, which is
 * why a module's own last segment is dropped first.
 *
 * Returns `null` when the dots walk past the top, which is a genuine error in the source rather than
 * something to guess at.
 */
export function resolveRelative(input: {
  readonly fromModule: string;
  readonly fromIsPackage: boolean;
  readonly dots: number;
  /** The dotted suffix after the dots, or `''` for a bare `from . import x`. */
  readonly suffix: string;
}): string | null {
  // Inside a package's `__init__.py`, one dot means the package itself; inside a module, one dot
  // means the package containing it.
  const base = input.fromIsPackage ? input.fromModule.split('.') : input.fromModule.split('.').slice(0, -1);
  const upward = input.dots - 1;

  if (upward > base.length) {
    return null;
  }

  const anchor = upward === 0 ? base : base.slice(0, base.length - upward);
  const parts = [...anchor, ...(input.suffix === '' ? [] : input.suffix.split('.'))];

  return parts.length === 0 ? null : parts.join('.');
}
