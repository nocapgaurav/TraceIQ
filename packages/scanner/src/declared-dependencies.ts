import type { Ecosystem } from './languages.js';

/**
 * Reads the dependency names a manifest declares.
 *
 * **Declaration, not resolution.** Every reader here is shallow by design: it extracts
 * the names a manifest states and nothing else. No version is interpreted, no lockfile is
 * consulted, no transitive graph is walked, and no attempt is made to decide whether a
 * dependency is actually used. A name appearing here means only "this manifest names it",
 * which is exactly what a reader can verify by opening the file.
 *
 * That shallowness is why these facts carry `INFERRED` confidence in the graph while a
 * resolved TypeScript import carries `RESOLVED`. The two are different kinds of claim and
 * the graph must not conflate them.
 *
 * A manifest that cannot be parsed yields no dependencies rather than an error. One
 * unreadable `pom.xml` must not cost a repository its entire scan, and the manifest is
 * still reported as present — only its contents are unknown.
 */
export function readDeclaredDependencies(input: {
  readonly ecosystem: Ecosystem;
  readonly contents: string;
}): readonly string[] {
  try {
    return dedupe(read(input.ecosystem, input.contents));
  } catch {
    return [];
  }
}

/**
 * The name a manifest gives its own package, or `null`.
 *
 * Read for the same reason the dependency names are: it is a plain statement in the file. Only npm
 * and Go are handled, because they are the two ecosystems whose manifests carry an unambiguous
 * self-name at a fixed key — a `pom.xml` names a group and an artifact and a `pyproject.toml` may
 * name a project or a poetry tool section, and guessing between them would be inventing a fact.
 */
export function readDeclaredName(input: {
  readonly ecosystem: Ecosystem;
  readonly contents: string;
}): string | null {
  try {
    if (input.ecosystem === 'npm' || input.ecosystem === 'composer') {
      const parsed: unknown = JSON.parse(input.contents);
      const name =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)['name']
          : undefined;

      return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
    }

    if (input.ecosystem === 'go') {
      // `module github.com/gin-gonic/gin` — the module path is the package's identity in Go, and
      // it is also how every dependent spells it.
      return /^module\s+(\S+)/m.exec(input.contents)?.[1] ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

function read(ecosystem: Ecosystem, contents: string): readonly string[] {
  switch (ecosystem) {
    case 'npm':
      return fromPackageJson(contents);

    case 'composer':
      return fromComposerJson(contents);

    case 'python':
      return fromPython(contents);

    case 'go':
      return fromGoMod(contents);

    case 'cargo':
      return fromCargoToml(contents);

    case 'maven':
      return fromPomXml(contents);

    case 'gradle':
      return fromGradle(contents);

    case 'bundler':
      return fromGemfile(contents);

    // A .csproj declares packages as XML attributes rather than element text, which the
    // Maven reader would miss. Left unread rather than half-read.
    case 'nuget':
      return [];
  }
}

const NPM_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function fromPackageJson(contents: string): readonly string[] {
  const parsed: unknown = JSON.parse(contents);
  const names: string[] = [];

  if (!isRecord(parsed)) {
    return names;
  }

  for (const section of NPM_SECTIONS) {
    const value = parsed[section];

    if (isRecord(value)) {
      names.push(...Object.keys(value));
    }
  }

  return names;
}

function fromComposerJson(contents: string): readonly string[] {
  const parsed: unknown = JSON.parse(contents);
  const names: string[] = [];

  if (!isRecord(parsed)) {
    return names;
  }

  for (const section of ['require', 'require-dev']) {
    const value = parsed[section];

    if (isRecord(value)) {
      // `php` and `ext-*` are platform requirements rather than packages.
      names.push(...Object.keys(value).filter((name) => name !== 'php' && !name.startsWith('ext-')));
    }
  }

  return names;
}

/**
 * requirements.txt and pyproject.toml, told apart by content.
 *
 * A `[project]` or `[tool.poetry]` table means TOML; anything else is treated as a
 * requirements list, which is also the right reading for Pipfile's plain entries.
 */
function fromPython(contents: string): readonly string[] {
  // The bracket may be followed by `]` for `[project]` or by `.` for a sub-table such as
  // `[tool.poetry.dependencies]`. Requiring `]` missed the latter, and the file was then
  // read as a requirements list — which parsed `python = "^3.11"` as a dependency.
  if (/^\s*\[(project|tool\.poetry|build-system)[\].]/m.test(contents)) {
    return fromPyprojectToml(contents);
  }

  return fromRequirementsTxt(contents);
}

const REQUIREMENT_SEPARATORS = /[<>=!~[;\s]/;

function fromRequirementsTxt(contents: string): readonly string[] {
  const names: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';

    // `-r other.txt`, `-e .`, `--index-url ...` are directives, not dependencies.
    if (line.length === 0 || line.startsWith('-')) {
      continue;
    }

    const name = line.split(REQUIREMENT_SEPARATORS)[0]?.trim();

    if (name !== undefined && name.length > 0) {
      names.push(name);
    }
  }

  return names;
}

function fromPyprojectToml(contents: string): readonly string[] {
  const names: string[] = [];

  // PEP 621: `dependencies = ["fastapi>=0.100", "pydantic"]`, possibly across lines.
  const array = bracketedAfter(contents, /(?:^|\n)\s*dependencies\s*=\s*\[/);

  if (array !== null) {
    for (const quoted of array.matchAll(/["']([^"']+)["']/g)) {
      const name = quoted[1]?.split(REQUIREMENT_SEPARATORS)[0]?.trim();

      if (name !== undefined && name.length > 0) {
        names.push(name);
      }
    }
  }

  // Poetry: a `[tool.poetry.dependencies]` table of `name = "^1.0"` entries.
  names.push(...fromTomlTable(contents, /\[tool\.poetry\.(?:dev-)?dependencies]/g));

  return names.filter((name) => name.toLowerCase() !== 'python');
}

/**
 * The text between a matching pair of brackets, starting at what `opening` matches.
 *
 * Depth-counted rather than matched with a non-greedy expression, which stops at the first
 * `]` it finds — and a requirement such as `uvicorn[standard]` contains one, so the rest of
 * the list was silently dropped.
 */
function bracketedAfter(contents: string, opening: RegExp): string | null {
  const match = opening.exec(contents);

  if (match === null) {
    return null;
  }

  const start = match.index + match[0].length;
  let depth = 1;

  for (let index = start; index < contents.length; index += 1) {
    const character = contents[index];

    if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;

      if (depth === 0) {
        return contents.slice(start, index);
      }
    }
  }

  // Unbalanced: read what there is rather than nothing, since the names already seen are
  // still names the manifest states.
  return contents.slice(start);
}

function fromCargoToml(contents: string): readonly string[] {
  return fromTomlTable(contents, /\[(?:dev-|build-)?dependencies]/g);
}

/**
 * Reads the keys of a TOML table, stopping at the next table header.
 *
 * A deliberately narrow reader rather than a TOML parser: it handles `name = value` and
 * `name = { ... }` entries, which is every shape a dependency table uses in practice.
 */
function fromTomlTable(contents: string, header: RegExp): readonly string[] {
  const names: string[] = [];

  for (const match of contents.matchAll(header)) {
    const start = (match.index ?? 0) + match[0].length;
    const rest = contents.slice(start);
    const end = rest.search(/\n\s*\[/);
    const body = end === -1 ? rest : rest.slice(0, end);

    for (const line of body.split(/\r?\n/)) {
      const entry = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line.split('#')[0] ?? '');

      if (entry?.[1] !== undefined) {
        names.push(entry[1]);
      }
    }
  }

  return names;
}

/** `require example.com/x v1.2.3`, single-line or inside a `require (...)` block. */
function fromGoMod(contents: string): readonly string[] {
  const names: string[] = [];

  for (const single of contents.matchAll(/^\s*require\s+([^\s(]+)\s+v/gm)) {
    if (single[1] !== undefined) {
      names.push(single[1]);
    }
  }

  for (const block of contents.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
    for (const line of (block[1] ?? '').split(/\r?\n/)) {
      const entry = /^\s*([^\s/]\S*)\s+v\S+/.exec(line.split('//')[0] ?? '');

      if (entry?.[1] !== undefined) {
        names.push(entry[1]);
      }
    }
  }

  return names;
}

/**
 * `<dependency><groupId>g</groupId><artifactId>a</artifactId></dependency>`.
 *
 * Matched with a regular expression rather than parsed. A dependency's coordinate is a
 * flat pair of elements in a shape that has not changed in twenty years, and adding an
 * XML parser to the scanner to read two tags would not buy correctness worth its weight.
 * The cost is stated: a `pom.xml` using entities or unusual namespacing reads as having
 * no dependencies, never as having wrong ones.
 */
function fromPomXml(contents: string): readonly string[] {
  const names: string[] = [];

  for (const dependency of contents.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = dependency[1] ?? '';
    const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(body)?.[1];
    const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(body)?.[1];

    if (artifact !== undefined) {
      names.push(group === undefined ? artifact : `${group}:${artifact}`);
    }
  }

  return names;
}

/** `implementation 'group:artifact:version'` and the `"..."` form. */
function fromGradle(contents: string): readonly string[] {
  const names: string[] = [];

  const configurations =
    /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor|kapt)\s*[( ]\s*["']([^"']+)["']/g;

  for (const match of contents.matchAll(configurations)) {
    const coordinate = match[1] ?? '';
    const parts = coordinate.split(':');

    if (parts.length >= 2) {
      names.push(`${parts[0]}:${parts[1]}`);
    }
  }

  return names;
}

/** `gem 'rails', '~> 7.0'`. */
function fromGemfile(contents: string): readonly string[] {
  const names: string[] = [];

  for (const match of contents.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
    if (match[1] !== undefined) {
      names.push(match[1]);
    }
  }

  return names;
}

/** Sorted and de-duplicated, so two scans of one repository agree. */
function dedupe(names: readonly string[]): readonly string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
