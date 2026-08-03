import type { ArtifactReference } from './types.js';

/**
 * Turning the text of an artefact into candidate paths and variable names.
 *
 * **The one rule here is that a candidate is a *normalisation*, never a guess.** `./scripts/build.sh`
 * relative to `.github/workflows/ci.yml` is `scripts/build.sh` if the workflow declares a root-relative
 * path and `.github/workflows/scripts/build.sh` if it declares a sibling — and which of those a CI
 * runner means depends on its working directory, which the file may not state. So both forms are offered
 * as candidates and the *repository's own inventory* decides which exists; where neither exists, the
 * reference is recorded as unresolved rather than pointed at the more plausible one.
 *
 * That is the same discipline the resolver follows for an import that binds to nothing, and it is what
 * keeps "this workflow runs `scripts/deploy.sh`" a checkable statement instead of a likely one.
 */

/** A path shape: at least one separator or a recognised extension, and no whitespace. */
const PATH_SHAPED = /^[\w@./~-]*[\w-](?:\/[\w@.~-]+)*(?:\.[\w]{1,8})?$/;

/** Extensions worth believing a bare, separator-free token is a file. */
const FILE_EXTENSION =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|sh|bash|sql|ya?ml|json|toml|xml|md|mdx|txt|env|tf|prisma|graphql|proto|lock|cfg|ini|properties|dockerfile|gradle|css|scss|html)$/i;

/** Command words that introduce a file argument rather than being one. */
const RUNNERS = new Set([
  'bash', 'sh', 'zsh', 'source', '.', 'node', 'python', 'python3', 'ruby', 'perl', 'go', 'java',
  'deno', 'bun', 'tsx', 'ts-node', 'make', 'docker', 'terraform', 'ansible-playbook', 'pytest',
]);

/** Environment variable references, in the three spellings artefacts use. */
const ENVIRONMENT_USE = /\$\{\{\s*(?:secrets|vars|env)\.([A-Z_][A-Z0-9_]*)\s*\}\}|\$\{([A-Z_][A-Z0-9_]*)[:\-}]|\$([A-Z_][A-Z0-9_]{2,})\b/g;

/** How many references one artefact may contribute. A generated document can name thousands of paths. */
export const REFERENCE_LIMIT = 60;

/**
 * The candidate paths one piece of artefact text denotes, most plausible first.
 *
 * Two forms, both mechanical: resolved against the repository root, and resolved against the artefact's
 * own directory. A path that is already root-relative produces one candidate; `./x` and `../x` produce the
 * directory-relative form only, because `./` explicitly means "beside me".
 */
export function candidatesFor(text: string, artifactPath: string): readonly string[] {
  const cleaned = text.trim().replace(/^["'`]|["'`]$/g, '').split('#')[0]?.split('?')[0] ?? '';

  if (cleaned === '' || cleaned.includes(' ') || /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
    return [];
  }

  if (!PATH_SHAPED.test(cleaned)) {
    return [];
  }

  // A bare token with no separator is only a file if its extension says so. Otherwise it is a command
  // name, a package name or a job name, and treating it as a path would fabricate a reference.
  if (!cleaned.includes('/') && !FILE_EXTENSION.test(cleaned)) {
    return [];
  }

  const directory = artifactPath.includes('/') ? artifactPath.slice(0, artifactPath.lastIndexOf('/')) : '';
  const relative = normalise(directory === '' ? cleaned : `${directory}/${cleaned}`);

  if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    return relative === null ? [] : [relative];
  }

  const root = normalise(cleaned);
  const both = [root, relative].filter((entry): entry is string => entry !== null && entry !== '');

  return [...new Set(both)];
}

/** Resolves `.` and `..` segments, or `null` where the path climbs above the repository root. */
function normalise(path: string): string | null {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (segments.pop() === undefined) {
        return null;
      }

      continue;
    }

    segments.push(segment);
  }

  return segments.join('/');
}

/**
 * The repository paths a command line invokes.
 *
 * Restricted to the **argument positions of a recognised runner** and to arguments that already look like
 * paths. `npm run build` names a script rather than a file, so it yields nothing here; `bash
 * scripts/deploy.sh` yields one path, and `python -m pytest tests/` yields `tests` only if the
 * repository holds it. Anything else in the line is left alone — a command interpreter is not something
 * to reimplement, and a wrong `RUNS` edge is a false claim about execution.
 */
export function invokedPaths(
  command: string,
  artifactPath: string,
): readonly { readonly text: string; readonly candidates: readonly string[] }[] {
  const found: { text: string; candidates: readonly string[] }[] = [];
  const seen = new Set<string>();

  // Split on the operators that separate commands, so each is considered on its own.
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = part.trim().split(/\s+/).filter((token) => token !== '');
    const head = tokens[0]?.toLowerCase() ?? '';
    const runner = RUNNERS.has(head) || head.endsWith('.sh');

    for (const [index, token] of tokens.entries()) {
      if (token.startsWith('-')) {
        continue;
      }

      // The head of a line is a path only when it is itself a script — `./scripts/build.sh`.
      const positional = index > 0 ? runner : token.startsWith('./') || token.startsWith('../') || token.includes('/');

      if (!positional) {
        continue;
      }

      const candidates = candidatesFor(token, artifactPath);

      if (candidates.length > 0 && !seen.has(token)) {
        seen.add(token);
        found.push({ text: token, candidates });
      }
    }
  }

  return found;
}

/** Environment variable names one piece of artefact text refers to. */
export function environmentNames(text: string): readonly string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(ENVIRONMENT_USE)) {
    const name = match[1] ?? match[2] ?? match[3];

    if (name !== undefined && name !== '') {
      names.add(name);
    }
  }

  return [...names];
}

/**
 * Collects references, deduplicated by kind and text, and capped.
 *
 * The cap is reported by the caller through the artefact's boundary sentence rather than silently
 * applied — a documentation file naming four hundred paths is described by sixty of them, and the reader
 * is told so.
 */
export class ReferenceCollector {
  readonly #entries: ArtifactReference[] = [];
  readonly #seen = new Set<string>();
  #dropped = 0;

  add(reference: ArtifactReference): void {
    /*
     * A path-shaped reference with no candidate path is not a reference.
     *
     * **The guard that keeps this layer from reporting phantom dead links.** A generic configuration reader
     * offers every value it reads as a possible path, which is right — a value may be one — and most are not:
     * `true`, `utf-8`, `lf`, `4`, a `#anchor`, an `https://` URL. Each of those correctly yields no
     * candidate, and recording it anyway put hundreds of unresolvable references into the graph, every one of
     * them a file the repository was never claiming to have. `environment` and `technology` references carry
     * no path by construction and are unaffected.
     */
    if (reference.candidates.length === 0 && reference.kind !== 'environment' && reference.kind !== 'technology') {
      return;
    }

    const key = `${reference.kind} ${reference.text} ${reference.candidates.join(',')}`;

    if (this.#seen.has(key)) {
      return;
    }

    this.#seen.add(key);

    if (this.#entries.length >= REFERENCE_LIMIT) {
      this.#dropped += 1;

      return;
    }

    this.#entries.push(reference);
  }

  /** Distinct references the cap discarded. Reported, never silent. */
  get dropped(): number {
    return this.#dropped;
  }

  entries(): readonly ArtifactReference[] {
    return this.#entries;
  }
}
