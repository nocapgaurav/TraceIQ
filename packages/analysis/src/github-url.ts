/**
 * GitHub repository URLs, validated before anything is cloned.
 *
 * Validation happens here rather than at the HTTP edge for two reasons: it is the one part of the
 * analysis workflow that is pure, and a bad URL should cost nothing — no workspace, no network, no
 * process. Everything downstream can then assume a well-formed owner and repository.
 *
 * The messages matter as much as the verdict. A rejected URL is the first thing a new user is likely to
 * see, so each failure says what was wrong *with this input* and what a correct one looks like, rather
 * than "invalid URL".
 */

/** A repository this workflow can clone. */
export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`, the form used in logs and in the UI. */
  readonly slug: string;
  /** The URL actually cloned. Always normalised — no `.git`, no trailing slash, no credentials. */
  readonly cloneUrl: string;
  /** The canonical page, for linking back to GitHub. */
  readonly htmlUrl: string;
}

export interface UrlRejection {
  readonly ok: false;
  readonly detail: string;
  readonly hint: string;
}

export type UrlVerdict = { readonly ok: true; readonly repository: GitHubRepository } | UrlRejection;

const EXAMPLE = 'https://github.com/facebook/react';

/**
 * GitHub's own rule: 1–100 characters of letters, digits, hyphen, underscore or dot.
 *
 * Applied to both owner and repository. Checking it here means a name that cannot exist is rejected
 * without a network round trip, and a name that *can* exist is left for GitHub to confirm.
 */
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/** Segments GitHub reserves for its own pages, which are never repositories. */
const RESERVED_OWNERS = new Set([
  'about',
  'apps',
  'blog',
  'collections',
  'contact',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
  'trending',
]);

export function parseGitHubUrl(input: string): UrlVerdict {
  const text = input.trim();

  if (text === '') {
    return reject('No repository URL was given.', `Paste a public GitHub URL, for example ${EXAMPLE}`);
  }

  // A bare `owner/name` is what people paste most often after a URL, and it is unambiguous, so it is
  // accepted rather than corrected. Anything else must be a real URL.
  const shorthand = asShorthand(text);
  const url = shorthand ?? asUrl(text);

  if (url === null) {
    return reject(
      `“${clip(text)}” is not a URL.`,
      `Paste the address of a public GitHub repository, for example ${EXAMPLE}`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return reject(
      `${url.protocol.replace(':', '')} URLs are not supported.`,
      `Use the https:// address from the repository page, for example ${EXAMPLE}`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    return reject(
      'The URL contains credentials.',
      'Only public repositories can be analysed, so no credentials are needed. Remove everything before the @.',
    );
  }

  const host = url.hostname.toLowerCase();

  if (host !== 'github.com' && host !== 'www.github.com') {
    return reject(
      `${url.hostname} is not GitHub.`,
      host.endsWith('gitlab.com') || host.endsWith('bitbucket.org')
        ? 'Only github.com is supported in this version.'
        : `Only public repositories on github.com can be analysed, for example ${EXAMPLE}`,
    );
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '');

  if (segments.length < 2) {
    return reject(
      segments.length === 0
        ? 'The URL points at GitHub itself, not at a repository.'
        : `The URL names the owner “${segments[0]}” but no repository.`,
      `A repository URL has two parts after the host, as in ${EXAMPLE}`,
    );
  }

  const owner = segments[0] as string;
  const name = stripGitSuffix(segments[1] as string);

  // `/owner/name/tree/main/src` and the like: the repository is still identifiable, but a branch or a
  // subdirectory is not something this version can honour, and cloning the default branch instead would
  // quietly analyse something other than what was asked for.
  if (segments.length > 2) {
    return reject(
      `The URL points inside the repository (${segments.slice(2).join('/')}), not at the repository itself.`,
      `Analysis covers a whole repository at its default branch. Use https://github.com/${owner}/${name}`,
    );
  }

  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    return reject(
      `“${owner}” is a GitHub site section, not an account.`,
      `Open the repository on GitHub and copy the address from the browser, for example ${EXAMPLE}`,
    );
  }

  for (const [label, segment] of [
    ['owner', owner],
    ['repository name', name],
  ] as const) {
    if (!SEGMENT.test(segment)) {
      return reject(
        `“${clip(segment)}” is not a valid GitHub ${label}.`,
        'GitHub names use letters, digits, hyphens, underscores and dots only.',
      );
    }
  }

  const slug = `${owner}/${name}`;

  return {
    ok: true,
    repository: {
      owner,
      name,
      slug,
      // Rebuilt from the parsed parts rather than passed through, so nothing from the input — a query
      // string, a fragment, an odd host casing — can reach the command line.
      cloneUrl: `https://github.com/${slug}.git`,
      htmlUrl: `https://github.com/${slug}`,
    },
  };
}

function asShorthand(text: string): URL | null {
  return /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(text)
    ? new URL(`https://github.com/${text}`)
    : null;
}

function asUrl(text: string): URL | null {
  // A pasted `github.com/owner/name` has no scheme; `new URL` rejects it, and prefixing https is what
  // the user meant. Anything with a scheme is parsed as written so the protocol check can see it.
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) ? text : `https://${text}`;

  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith('.git') ? segment.slice(0, -'.git'.length) : segment;
}

function reject(detail: string, hint: string): UrlRejection {
  return { ok: false, detail, hint };
}

/** Keeps a rejected value short enough to read in a message. */
function clip(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}…`;
}
