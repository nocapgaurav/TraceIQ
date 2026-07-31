import { describe, expect, it } from 'vitest';

import { parseGitHubUrl } from './github-url.js';

/**
 * URL validation.
 *
 * A rejected URL is the first thing a new user is likely to see, so these assert the *message* as well
 * as the verdict: every rejection has to say what was wrong with this input, not "invalid URL".
 */
describe('parseGitHubUrl', () => {
  describe('accepts', () => {
    it.each([
      ['https://github.com/facebook/react', 'facebook/react'],
      ['https://github.com/vercel/next.js', 'vercel/next.js'],
      ['https://github.com/openai/openai-node', 'openai/openai-node'],
      ['http://github.com/facebook/react', 'facebook/react'],
      ['https://www.github.com/facebook/react', 'facebook/react'],
      ['https://github.com/facebook/react.git', 'facebook/react'],
      ['https://github.com/facebook/react/', 'facebook/react'],
      ['  https://github.com/facebook/react  ', 'facebook/react'],
      ['github.com/facebook/react', 'facebook/react'],
      ['facebook/react', 'facebook/react'],
      ['https://github.com/a_b/c.d-e', 'a_b/c.d-e'],
    ])('%s', (input, slug) => {
      const verdict = parseGitHubUrl(input);

      expect(verdict.ok).toBe(true);
      expect(verdict.ok && verdict.repository.slug).toBe(slug);
    });

    it('normalises the clone URL rather than passing the input through', () => {
      // A query string, a fragment and odd host casing must not reach the command line.
      const verdict = parseGitHubUrl('https://GitHub.com/facebook/react.git?tab=readme#top');

      expect(verdict.ok).toBe(true);
      expect(verdict.ok && verdict.repository.cloneUrl).toBe('https://github.com/facebook/react.git');
      expect(verdict.ok && verdict.repository.htmlUrl).toBe('https://github.com/facebook/react');
    });
  });

  describe('rejects, saying what was wrong', () => {
    it('an empty string', () => {
      const verdict = parseGitHubUrl('   ');

      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.detail).toMatch(/No repository URL/);
      expect(!verdict.ok && verdict.hint).toContain('github.com/facebook/react');
    });

    it('a host that is not GitHub, naming the host', () => {
      const verdict = parseGitHubUrl('https://gitlab.com/owner/repo');

      expect(!verdict.ok && verdict.detail).toBe('gitlab.com is not GitHub.');
      expect(!verdict.ok && verdict.hint).toMatch(/Only github.com is supported/);
    });

    it('an SSH remote, naming the protocol', () => {
      const verdict = parseGitHubUrl('ssh://git@github.com/facebook/react.git');

      expect(!verdict.ok && verdict.detail).toMatch(/ssh URLs are not supported/);
    });

    it('a URL carrying credentials', () => {
      const verdict = parseGitHubUrl('https://user:token@github.com/owner/repo');

      expect(!verdict.ok && verdict.detail).toBe('The URL contains credentials.');
      expect(!verdict.ok && verdict.hint).toMatch(/no credentials are needed/);
    });

    it('the GitHub home page', () => {
      const verdict = parseGitHubUrl('https://github.com');

      expect(!verdict.ok && verdict.detail).toMatch(/points at GitHub itself/);
    });

    it('an owner with no repository, naming the owner', () => {
      const verdict = parseGitHubUrl('https://github.com/facebook');

      expect(!verdict.ok && verdict.detail).toBe('The URL names the owner “facebook” but no repository.');
    });

    /** A branch or subdirectory URL is the most common paste after the plain repository URL. */
    it('a link inside the repository, offering the repository URL instead', () => {
      const verdict = parseGitHubUrl('https://github.com/facebook/react/tree/main/packages');

      expect(!verdict.ok && verdict.detail).toMatch(/points inside the repository \(tree\/main\/packages\)/);
      expect(!verdict.ok && verdict.hint).toContain('https://github.com/facebook/react');
    });

    it('a GitHub site section rather than an account', () => {
      const verdict = parseGitHubUrl('https://github.com/topics/typescript');

      expect(!verdict.ok && verdict.detail).toMatch(/is a GitHub site section/);
    });

    it('a name GitHub could not have', () => {
      const verdict = parseGitHubUrl('https://github.com/owner/re po');

      expect(!verdict.ok && verdict.detail).toMatch(/is not a valid GitHub repository name/);
    });

    it('something that is not a URL at all', () => {
      const verdict = parseGitHubUrl('the react repository please');

      expect(!verdict.ok && verdict.detail).toMatch(/is not a URL/);
    });

    it('clips a very long value so the message stays readable', () => {
      const verdict = parseGitHubUrl(`https://github.com/owner/${'x'.repeat(200)}`);

      expect(!verdict.ok && verdict.detail.length).toBeLessThan(120);
    });
  });

  it('never returns a repository for input it rejected', () => {
    const inputs = ['', 'https://gitlab.com/a/b', 'https://github.com/only-owner', 'not a url'];

    for (const input of inputs) {
      expect(parseGitHubUrl(input).ok).toBe(false);
    }
  });
});
