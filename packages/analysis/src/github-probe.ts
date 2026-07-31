import type { GitHubRepository } from './github-url.js';

/**
 * Does this repository exist, and can an anonymous client read it?
 *
 * **Why this exists.** The milestone asks for "repository not found" and "repository is private" as
 * distinct failures, and git alone cannot tell them apart. Running it showed why: with a hermetic
 * environment — no askpass helper, prompts disabled, which is what a server should have — a missing
 * repository and a private one both produce
 *
 *   fatal: could not read Username for 'https://github.com': terminal prompts disabled
 *
 * because GitHub answers 404 to anonymous requests for both, and git then tries to authenticate. Giving
 * git an askpass helper so it reaches GitHub's clearer "Repository not found." would mean a server
 * process invoking a credential helper, which is worse than the ambiguity.
 *
 * One unauthenticated `GET /repos/{owner}/{name}` settles it before anything is cloned: 200 means public,
 * 404 means not visible. That is also the cheapest way to reject a typo — no clone at all.
 *
 * **It fails open.** If the API cannot be reached, is rate limited, or answers something unexpected, the
 * verdict is `unknown` and the clone proceeds. A probe that cannot answer must not block work that might
 * still succeed.
 */
export type ProbeVerdict = 'public' | 'missing' | 'unknown';

export interface RepositoryProbe {
  probe(repository: GitHubRepository, signal?: AbortSignal): Promise<ProbeVerdict>;
}

export class GitHubApiProbe implements RepositoryProbe {
  constructor(private readonly timeoutMs = 10_000) {}

  async probe(repository: GitHubRepository, signal?: AbortSignal): Promise<ProbeVerdict> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    // Either the caller's cancellation or the probe's own timeout ends the request.
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    try {
      const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.name}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'traceiq-repository-analysis',
        },
        signal: combined,
      });

      if (response.status === 404) {
        return 'missing';
      }

      if (!response.ok) {
        // 403 is the rate limit, 5xx is GitHub's problem. Neither says anything about the repository.
        return 'unknown';
      }

      const body = (await response.json()) as { readonly private?: unknown };

      // A 200 for an anonymous client already means public; the field is checked rather than assumed.
      return body.private === true ? 'missing' : 'public';
    } catch {
      return 'unknown';
    }
  }
}

/** A probe that answers `unknown` for everything, for tests that must not touch the network. */
export const OFFLINE_PROBE: RepositoryProbe = {
  probe: async () => 'unknown',
};
