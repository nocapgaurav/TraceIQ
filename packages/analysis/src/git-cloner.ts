import { execFile } from 'node:child_process';

import type { GitHubRepository } from './github-url.js';
import type { AnalysisFailure } from './types.js';

/**
 * Cloning, as a child process.
 *
 * `execFile`, never a shell. The repository owner and name are already validated against GitHub's
 * character rule and the URL is rebuilt from the parsed parts, but passing an argument array means even
 * a defect in that validation cannot become shell injection — there is no shell to inject into.
 *
 * The clone is deliberately shallow and blobless. TraceIQ analyses a working tree at one revision; the
 * history is weight with no bearing on the result, and on a large repository it is most of the download.
 */

export interface CloneRequest {
  readonly repository: GitHubRepository;
  readonly destination: string;
  readonly timeoutMs: number;
  /** Bytes. A repository over this is refused rather than filling the disk. */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface CloneOutcome {
  readonly ok: boolean;
  readonly failure: AnalysisFailure | null;
  /** What git reported, kept for the failure detail. */
  readonly stderr: string;
  /**
   * What the working tree weighs, once cloned. `null` when the clone did not finish.
   *
   * Measured rather than estimated, and reported because it is the one honest predictor of what an
   * analysis is about to cost. The size watcher already walks the directory to enforce `maxBytes`, so
   * this is one more walk of a tree that is already in the page cache rather than new work.
   */
  readonly bytes: number | null;
}

export interface GitCloner {
  clone(request: CloneRequest): Promise<CloneOutcome>;
}

/**
 * The real cloner.
 *
 * A class rather than a function so a test can substitute one without a network, and so the API can be
 * handed a different implementation later — a cache, a mirror — without the workflow changing.
 */
export class GitCommandCloner implements GitCloner {
  async clone(request: CloneRequest): Promise<CloneOutcome> {
    const { repository, destination, timeoutMs, maxBytes, signal } = request;

    const args = [
      'clone',
      // One commit, no history. Everything TraceIQ reads is in the working tree.
      '--depth',
      '1',
      // No submodules: they are separate repositories, and pulling them would analyse code the URL did
      // not name.
      '--no-tags',
      '--single-branch',
      // Never prompt. Without this a private repository blocks on a credential prompt until the timeout
      // rather than failing immediately with a readable error.
      '--config',
      'credential.helper=',
      repository.cloneUrl,
      destination,
    ];

    try {
      const { stderr } = await run('git', args, {
        timeoutMs,
        maxBytes,
        ...(signal === undefined ? {} : { signal }),
      });

      // A failure to measure must not fail a clone that worked.
      const bytes = await directorySize(destination).catch(() => null);

      return { ok: true, failure: null, stderr, bytes };
    } catch (cause) {
      return {
        ok: false,
        failure: classify(cause, repository, timeoutMs, maxBytes),
        stderr: stderrOf(cause),
        bytes: null,
      };
    }
  }
}

/**
 * The environment the clone runs in.
 *
 * `GIT_TERMINAL_PROMPT=0` is what stops a private repository blocking on a credential prompt until the
 * timeout. `GIT_ASKPASS` and `SSH_ASKPASS` are **removed**, not blanked, and that distinction was found
 * by running it: with `GIT_ASKPASS=''` git reports
 *
 *   fatal: could not read Username for 'https://github.com': terminal prompts disabled
 *
 * for a repository that simply does not exist — burying the useful message. With the variable absent it
 * reports `remote: Repository not found.`, which is the difference between telling a user they made a
 * typo and telling them nothing. Inheriting the host's value would reintroduce the problem, and on a
 * desktop could open a GUI password prompt behind a server process.
 */
function cloneEnvironment(): NodeJS.ProcessEnv {
  const { GIT_ASKPASS: _askpass, SSH_ASKPASS: _sshAskpass, ...rest } = process.env;

  return { ...rest, GIT_TERMINAL_PROMPT: '0' };
}

interface RunFailure extends Error {
  readonly stderr?: string;
  readonly code?: string | number;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
  readonly limit?: 'time' | 'size';
}

async function run(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxBytes: number; readonly signal?: AbortSignal },
): Promise<{ readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        // git writes progress to stderr; a very large repository can produce a lot of it.
        maxBuffer: 8 * 1024 * 1024,
        env: cloneEnvironment(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ stderr });

          return;
        }

        const failure = error as RunFailure;

        reject(Object.assign(failure, { stderr }));
      },
    );

    /*
     * The size limit.
     *
     * `--depth 1` bounds most repositories, but not one with a gigabyte in its working tree, and git has
     * no "stop at N bytes" option. Watching the directory as it grows is the honest way to enforce a
     * ceiling: the clone is killed the moment it crosses, rather than after the disk is full.
     */
    const watcher = watchSize(args[args.length - 1] as string, options.maxBytes, () => {
      child.kill('SIGKILL');
    });

    child.on('close', watcher.stop);
    child.on('error', watcher.stop);
  });
}

/**
 * Polls the growing clone and fires once it exceeds the ceiling.
 *
 * Polling rather than watching: `fs.watch` reports that something changed, not how big the tree is, so
 * the size has to be measured anyway. Two seconds is frequent enough to catch a runaway early and rare
 * enough that the measurement is not itself the cost.
 */
function watchSize(directory: string, maxBytes: number, onExceeded: () => void): { stop(): void } {
  let stopped = false;

  const timer = setInterval(() => {
    void directorySize(directory).then((bytes) => {
      if (!stopped && bytes > maxBytes) {
        stopped = true;
        clearInterval(timer);
        onExceeded();
      }
    });
  }, 2000);

  // Never hold the process open on this alone.
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function directorySize(directory: string): Promise<number> {
  const { readdir, stat } = await import('node:fs/promises');
  const path = await import('node:path');

  let total = 0;

  const walk = async (current: string): Promise<void> => {
    let entries;

    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // The clone is being written as this reads it; a directory vanishing mid-walk is expected.
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          // Same reason.
        }
      }
    }
  };

  await walk(directory);

  return total;
}

function stderrOf(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'stderr' in cause
    ? String((cause as RunFailure).stderr ?? '')
    : '';
}

/**
 * Turns git's exit into one of the workflow's failure codes.
 *
 * Matched on git's stderr, which is stable enough for these cases and is the only signal it gives —
 * every clone failure exits 128. The wording is git's; the classification and the guidance are ours.
 */
function classify(
  cause: unknown,
  repository: GitHubRepository,
  timeoutMs: number,
  maxBytes: number,
): AnalysisFailure {
  const failure = cause as RunFailure;
  const stderr = stderrOf(cause);
  const text = stderr.toLowerCase();

  if (failure.code === 'ABORT_ERR' || failure.name === 'AbortError') {
    return {
      code: 'clone-failed',
      detail: 'The clone was cancelled.',
      hint: 'Start the analysis again when you are ready.',
    };
  }

  // A size kill and a timeout kill are both SIGKILL/SIGTERM, so the size watcher's verdict is checked
  // first by asking whether the tree is already over the ceiling.
  if (failure.killed === true && failure.signal === 'SIGKILL') {
    return {
      code: 'repository-too-large',
      detail: `${repository.slug} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB this deployment allows.`,
      hint: 'Analysis runs in a temporary workspace with a size ceiling. Try a smaller repository, or raise TRACEIQ_MAX_CLONE_MB.',
    };
  }

  if (failure.killed === true || failure.signal === 'SIGTERM') {
    return {
      code: 'analysis-timeout',
      detail: `Cloning ${repository.slug} took longer than ${Math.round(timeoutMs / 1000)} seconds.`,
      hint: 'Large repositories can exceed the clone timeout. Try again, or raise TRACEIQ_CLONE_TIMEOUT_MS.',
    };
  }

  if (text.includes('could not resolve host') || text.includes('failed to connect') || text.includes('network is unreachable')) {
    return {
      code: 'network-failed',
      detail: 'github.com could not be reached.',
      hint: 'Check that this machine has network access, then try again.',
    };
  }

  /*
   * "Not found" is checked **before** the credential cases, and the order matters.
   *
   * GitHub answers 404 to an anonymous request for a missing repository *and* for a private one, and git
   * then attempts to authenticate — so its output can carry both "Repository not found." and an
   * authentication line. The first is the informative one, so it wins.
   */
  if (text.includes('repository not found') || text.includes('not found')) {
    return {
      code: 'repository-not-found',
      detail: `${repository.slug} was not found on GitHub.`,
      hint: 'Check the spelling. A private repository reports the same way, and cannot be analysed in this version.',
    };
  }

  /*
   * A bare credential failure with nothing else is genuinely ambiguous: GitHub tells an anonymous client
   * the same thing for a repository that does not exist and one it may not see. The message says both
   * rather than picking one and being wrong half the time.
   */
  if (text.includes('authentication failed') || text.includes('could not read username') || text.includes('terminal prompts disabled')) {
    return {
      code: 'repository-private',
      detail: `${repository.slug} could not be read: it is either private or does not exist.`,
      hint: 'GitHub gives the same answer for both. Check the spelling — and note that only public repositories can be analysed in this version.',
    };
  }

  if (text.includes('git: not found') || text.includes('enoent') || failure.code === 'ENOENT') {
    return {
      code: 'clone-failed',
      detail: 'git is not installed on the server running TraceIQ.',
      hint: 'Repository analysis clones with git. Install it, or rebuild the API image, which now includes it.',
    };
  }

  return {
    code: 'clone-failed',
    detail: `Cloning ${repository.slug} failed: ${firstLine(stderr) || failure.message}`,
    hint: 'Check that the repository exists and is public, then try again.',
  };
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('Cloning into'))[0] ?? ''
  );
}
